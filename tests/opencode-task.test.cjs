// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {OpenCodeTask, MODEL} = require('../src/opencode-task.cjs');
function answer(session = 'ses_root') {
  return {info: {id: 'msg_result', sessionID: session, role: 'assistant', providerID: 'volparossa', modelID: MODEL,
    finish: 'stop', time: {completed: 1}, path: {cwd: '/workspace'}}, parts: [
    {id: 'prt_text', sessionID: session, messageID: 'msg_result', type: 'text', text: 'Synthetic response.'},
  ]};
}
class Client extends EventEmitter {
  constructor(run = async () => answer()) { super(); this.workspace = '/workspace'; this.ready = false; this.run = run; this.calls = []; }
  async connect() { this.ready = true; }
  async createSession() { return {id: 'ses_root', directory: this.workspace, model: {id: MODEL, providerID: 'volparossa'}}; }
  async prompt(id, text, options) { this.calls.push(['prompt', id, text]); return this.run(this, options); }
  async getSession(id) { return {id, directory: this.workspace, parentID: id === 'ses_child' ? 'ses_root' : 'ses_foreign'}; }
  async abort(id) { this.calls.push(['abort', id]); return true; }
  async deleteSession(id) { this.calls.push(['delete', id]); return true; }
  async replyPermission(id, accepted) { this.calls.push(['permission', id, accepted]); return true; }
}
function tool(client, {session = 'ses_root', kind = 'bash', input = {command: 'node --test'}, status = 'running'} = {}) {
  client.emit('event', {type: 'message.part.updated', properties: {sessionID: session, part: {
    id: 'prt_tool', type: 'tool', sessionID: session, messageID: 'msg_tool', callID: 'call_fixture', tool: kind,
    state: {status, input},
  }}});
}
function permission(client, {session = 'ses_root', id = 'per_fixture', kind = 'bash', patterns = ['node --test'], metadata = {}} = {}) {
  client.emit('event', {type: 'permission.asked', properties: {id, sessionID: session, permission: kind,
    patterns, metadata, always: ['*'], tool: {messageID: 'msg_tool', callID: 'call_fixture'}}});
}
test('verified terminal native result, explicit one-shot command approval, and session cleanup', async () => {
  const proposals = [];
  const client = new Client(async c => { tool(c); permission(c); tool(c, {status: 'completed'}); return answer(); });
  const task = new OpenCodeTask(client, async value => { proposals.push(value); return true; });
  const result = await task.run('Synthetic coding task');
  assert.equal(proposals[0].command, 'node --test');
  assert.deepEqual(client.calls.filter(c => c[0] === 'permission'), [['permission', 'per_fixture', true]]);
  assert.equal(result.commands, 1); assert.equal(result.nativeTurnCompleted, true); assert.equal(result.taskVerified, false);
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
});
test('descendant session may request approval but unrelated sessions and network permissions cannot', async () => {
  const client = new Client(async c => {
    tool(c, {session: 'ses_child'}); permission(c, {session: 'ses_child', id: 'per_child'});
    permission(c, {session: 'ses_unknown', id: 'per_unknown'});
    permission(c, {kind: 'external_directory', id: 'per_external'}); return answer();
  });
  let approvals = 0;
  const task = new OpenCodeTask(client, async p => { approvals++; assert.equal(p.child, true); return true; });
  await task.run('Task'); assert.equal(approvals, 1);
  assert.deepEqual(client.calls.filter(c => c[0] === 'permission').map(c => c.slice(1)),
    [['per_child', true], ['per_unknown', false], ['per_external', false]]);
});
test('edits show exact scoped request and are one-shot; outside paths are refused', async () => {
  const client = new Client(async c => {
    tool(c, {kind: 'edit', input: {filePath: '/workspace/index.js'}});
    permission(c, {kind: 'edit', patterns: ['index.js'], metadata: {filepath: '/workspace/index.js', diff: 'synthetic diff'}});
    permission(c, {id: 'per_outside', kind: 'edit', patterns: ['../secret']}); return answer();
  });
  const task = new OpenCodeTask(client, async p => p.permission === 'edit' && p.metadata.diff === 'synthetic diff');
  await task.run('Task');
  assert.deepEqual(client.calls.filter(c => c[0] === 'permission').map(c => c.slice(1)), [['per_fixture', true], ['per_outside', false]]);
});
test('cancel during approval rejects late acceptance, aborts owned session, removes it', async () => {
  const controller = new AbortController(); let resolveApproval;
  const client = new Client(async (c, {signal}) => {
    tool(c); permission(c);
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), {once: true}));
  });
  const task = new OpenCodeTask(client, () => {
    queueMicrotask(() => controller.abort()); return new Promise(resolve => { resolveApproval = resolve; });
  });
  await assert.rejects(task.run('Task', {signal: controller.signal}), /cancelled/);
  resolveApproval(true);
  assert.deepEqual(client.calls.filter(c => c[0] === 'permission'), [['permission', 'per_fixture', false]]);
  assert.ok(client.calls.some(c => c[0] === 'abort')); assert.equal(client.calls.at(-1)[0], 'delete');
});
test('wrong lineage/model, truncated output and unconfirmed cleanup cannot count as completion', async () => {
  for (const change of [r => { r.info.sessionID = 'ses_other'; }, r => { r.info.modelID = 'other'; },
    r => { r.info.finish = 'length'; }, r => { r.parts[0].text = 'x'.repeat(65537); }]) {
    const client = new Client(async () => { const r = answer(); change(r); return r; });
    await assert.rejects(new OpenCodeTask(client, async () => true).run('Task'), /incomplete|output_bound/);
    assert.equal(client.calls.at(-1)[0], 'delete');
  }
  const client = new Client(); client.deleteSession = async () => false;
  await assert.rejects(new OpenCodeTask(client, async () => true).run('Task'), /cleanup_unconfirmed/);
});
test('duplicate permission requests fail closed and no prompt is accepted twice', async () => {
  const client = new Client(async c => { tool(c); permission(c); permission(c); return answer(); });
  const task = new OpenCodeTask(client, async () => true);
  await assert.rejects(task.run('Task'), /event/);
  assert.equal(client.calls.filter(c => c[0] === 'permission').length, 1);
  await assert.rejects(task.run('Again'), /scope/);
});
