// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {OpenCodeTask, MODEL} = require('../src/opencode-task.cjs');
const {emptyTaskDiagnostic, validTaskDiagnostic} = require('../src/opencode-bridge.cjs');
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
  assert.deepEqual(task.diagnostics.permissions, {requested: 1, forwarded: 1, accepted: 1, rejected: 0, unconfirmed: 0});
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
});
test('read without approval and a failed tool are distinguishable without exporting private details', async () => {
  for (const status of ['completed', 'error']) {
    const client = new Client(async c => {
      tool(c, {kind: 'read', input: {filePath: '/workspace/PRIVATE_CANARY'}});
      tool(c, {kind: 'read', status, input: {filePath: '/workspace/PRIVATE_CANARY'}});
      tool(c, {kind: 'read', status}); // Repeated metadata updates are not extra executions.
      tool(c, {session: 'ses_foreign', kind: 'bash', status: 'completed'});
      return answer();
    });
    let approvals = 0;
    const task = new OpenCodeTask(client, async () => { approvals++; return true; });
    const result = await task.run('Private synthetic input');
    assert.equal(result.commands, 0); assert.equal(approvals, 0);
    assert.equal(result.taskVerified, false); // A completed read is not successful coding.
    assert.equal(task.diagnostics.observed_calls, 1);
    assert.equal(task.diagnostics.tools.read.running, 1);
    assert.equal(task.diagnostics.tools.read[status], 1);
    assert.equal(task.diagnostics.tools.bash.completed, 0);
    assert.deepEqual(task.diagnostics.permissions, emptyTaskDiagnostic().permissions);
    assert.equal(validTaskDiagnostic(task.diagnostics), true);
    assert.ok(!JSON.stringify(task.diagnostics).includes('PRIVATE_CANARY'));
    task.diagnostics.tools.read.running = 100;
    assert.equal(task.diagnostics.tools.read.running, 1);
  }
});
test('unknown tool names are closed other counts and diagnostic limits do not grant or fail work', async () => {
  const client = new Client(async c => {
    tool(c, {kind: 'PRIVATE_CANARY', status: 'error'});
    return answer();
  });
  const task = new OpenCodeTask(client, async () => assert.fail('no approval'));
  await task.run('Task');
  assert.equal(task.diagnostics.tools.other.error, 1);
  assert.ok(!JSON.stringify(task.diagnostics).includes('PRIVATE_CANARY'));
  for (let id = 0; id < 1025; id++) task.observeTool(`synthetic_${id}`,
    {tool: 'read', state: {status: 'pending'}});
  assert.equal(task.diagnostics.truncated, true);
  assert.equal(task.observedTools.size, 1024);
  assert.equal(task.error, null);
});
test('rejected and unconfirmed approvals remain distinct through cleanup', async () => {
  for (const confirmed of [true, false]) {
    const client = new Client(async c => { tool(c); permission(c); return answer(); });
    client.replyPermission = async () => confirmed;
    const task = new OpenCodeTask(client, async () => false);
    if (confirmed) await task.run('Task');
    else await assert.rejects(task.run('Task'), /permission_unconfirmed/);
    assert.deepEqual(task.diagnostics.permissions,
      {requested: 1, forwarded: 1, accepted: 0, rejected: Number(confirmed), unconfirmed: Number(!confirmed)});
  }
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
  await assert.rejects(task.run('Task'), /permission_replay/);
  assert.equal(client.calls.filter(c => c[0] === 'permission').length, 1);
  await assert.rejects(task.run('Again'), /scope/);
});
test('first native failure survives its request cancellation and failed session deletion', async () => {
  for (const removed of [true, false]) {
    const client = new Client(async (c, {signal}) => {
      const pending = new Promise((_, reject) => signal.addEventListener('abort',
        () => reject(Error('opencode_cancelled')), {once: true}));
      c.emit('event', {type: 'session.error', properties: {sessionID: 'ses_root', error: 'PRIVATE_CANARY'}});
      return pending;
    });
    client.deleteSession = async () => removed;
    await assert.rejects(new OpenCodeTask(client, async () => false).run('Task'), error => {
      assert.equal(error.code ?? error.message, 'opencode_task_native_error');
      assert.equal(error.taskCleanupFailure, removed ? undefined : 'session_cleanup_unconfirmed');
      assert.ok(!error.message.includes('CANARY'));
      return true;
    });
  }
});
