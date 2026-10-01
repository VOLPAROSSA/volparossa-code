// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { validateConversation, PrivateConversation } = require('../src/private-conversation.cjs');
const { caps, input, result, frame, reply, fixture } = require('./conversation-fixture.cjs');

test('actual framed socket uses separate handshake and yields exact cleanup-confirmed conversation result', async t => {
  const original = result();
  const f = await fixture(t, (socket, request) => {
    const bytes = Buffer.concat([frame({ version: 1, id: request.id, event: 'admitted' }),
      frame({ version: 1, id: request.id, event: 'result', result: original })]);
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => socket.write(bytes.subarray(2)));
  });
  assert.deepEqual(await f.client.connect(), caps());
  assert.deepEqual(await f.client.submit(input()), original);
  assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation']);
  await assert.rejects(f.client.ask({ question: 'legacy', context: 'must not send' }));
});

test('public/cloud/widened/unknown capabilities fail before any task', async t => {
  for (const change of [{ network_access: true }, { training: true }, { cloud_fallback: true },
    { max_prompt_tokens: 999999 }, { native_tool_template: true }, { model_profile: 'unknown' },
    { arbitrary_json_schema_validation: true }, { max_seconds: 0 }, { max_request_bytes: 999999 }]) {
    const f = await fixture(t, () => assert.fail('unexpected submit'), { ...caps(), ...change });
    await assert.rejects(f.client.connect());
    assert.equal(f.requests.length, 1);
  }
});

test('history preserves exact namespaced calls and requires one matching result before the next message', () => {
  const value = input([{ type: 'function', namespace: 'workspace', name: 'read', description: 'Read approved file.',
    parameters: { type: 'object', properties: { file: { type: 'string' } } } }]);
  value.history.push({ type: 'function_call', namespace: 'workspace', name: 'read', call_id: 'c1', arguments: { file: 'demo' } },
    { type: 'tool_result', call_id: 'c1', output: 'Public fixture bytes.' });
  validateConversation(value);
  for (const alter of [v => { v.history[2].call_id = 'other'; }, v => { v.history[1].namespace = null; },
    v => { v.history.splice(2, 0, { type: 'message', role: 'user', text: 'interrupt' }); },
    v => { v.history.push(v.history[2]); }, v => { v.tools = []; },
    v => { v.history[1].arguments = 'not object'; }, v => { v.instructions = 'x'.repeat(4097); }]) {
    const invalid = structuredClone(value); alter(invalid);
    assert.throws(() => validateConversation(invalid));
  }
});

test('cleanup uncertainty, wrong tool identity and historical call reuse never expose output', async t => {
  const request = input([{ type: 'custom', name: 'patch', namespace: null, description: 'Propose a literal patch.' }]);
  request.history.push({ type: 'custom_tool_call', name: 'patch', namespace: null, call_id: 'old', input: 'example' },
    { type: 'tool_result', call_id: 'old', output: 'fixture' });
  for (const output of [
    { type: 'custom_tool_call', name: 'other', namespace: null, call_id: 'new', input: 'must not run' },
    { type: 'custom_tool_call', name: 'patch', namespace: null, call_id: 'old', input: 'must not run' },
    { type: 'custom_tool_call', name: 'patch', call_id: 'new', input: 'missing namespace' },
  ]) {
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(output) });
    });
    await f.client.connect(); await assert.rejects(f.client.submit(request));
  }
  const invalid = result(); invalid.cleanup.complete = false;
  const f = await fixture(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: invalid });
  });
  await f.client.connect(); await assert.rejects(f.client.submit(input()), { code: 'cleanup_unconfirmed' });
});

test('cancellation acknowledgement does not settle until the exact task cleanup terminal', async t => {
  let task, authorize;
  const ready = new Promise(resolve => { authorize = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit_conversation') { task = request; reply(socket, request, 'admitted'); }
    else { assert.equal(request.operation.task_id, task.id);
      reply(socket, request, 'cancel_requested', { task_id: task.id });
      authorize(() => reply(socket, task, 'error', { code: 'cancelled' })); }
  });
  await f.client.connect();
  const controller = new AbortController();
  const pending = f.client.submit(input(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  controller.abort();
  const finish = await ready;
  let settled = false; pending.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  finish(); await rejected;
});

test('conversation inherits exact owned socket/parent boundary and rejects false result correlation', async t => {
  const f = await fixture(t, (socket, request) => reply(socket, { id: 'f'.repeat(32) }, 'result', { result: result() }));
  await fs.chmod(f.socketPath, 0o666);
  await assert.rejects(new PrivateConversation(f.socketPath).connect(), { code: 'socket_ownership' });
  await fs.chmod(f.socketPath, 0o600);
  await f.client.connect(); await assert.rejects(f.client.submit(input()), { code: 'invalid_response' });
});
