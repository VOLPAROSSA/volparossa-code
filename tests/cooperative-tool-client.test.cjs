// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {once} = require('node:events');
const {CooperativeToolClient} = require('../src/cooperative-tool-client.cjs');
const {readFrames, writeFrame} = require('../src/opencode-bridge.cjs');
const CALL = 'call_public_fixture';
const VALUE = {tool_call_id: CALL, core_task_id: 'core-fixture', visibility: 'public_cooperative',
  result: {text: 'Unchanged synthetic peer output', nested: {arbitrary_core_field: true}}};

async function fixture(t, receive) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vpc-tool-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'proxy.sock'), connections = new Set(), messages = [];
  const server = net.createServer(socket => {
    connections.add(socket); socket.on('error', () => {}); socket.once('close', () => connections.delete(socket));
    readFrames(socket, value => { messages.push(value); receive(socket, value); }, () => socket.destroy());
  });
  server.listen(socketPath); await once(server, 'listening'); await fs.chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, {recursive: true});
  });
  return {socketPath, directory, messages};
}
test('only upstream call ID crosses the fixed-snapshot proxy and terminal core result is unchanged', async t => {
  const f = await fixture(t, socket => { writeFrame(socket, {type: 'result', value: VALUE}); socket.end(); });
  const client = new CooperativeToolClient(f.socketPath);
  assert.deepEqual(await client.execute(CALL), VALUE);
  assert.deepEqual(f.messages, [{type: 'execute', call_id: CALL}]);
  await assert.rejects(client.execute(CALL), /cooperation_failed/);
});
test('missing terminal, wrong call, private visibility, extra fields and duplicate frames fail closed', async t => {
  for (const frames of [[], [{type: 'result', value: {...VALUE, tool_call_id: 'wrong'}}],
    [{type: 'result', value: {...VALUE, visibility: 'private_local'}}],
    [{type: 'result', value: {...VALUE, secret: 'not accepted'}}],
    [{type: 'result', value: VALUE}, {type: 'result', value: VALUE}],
    [{type: 'error', code: 'cleanup_unconfirmed'}]]) {
    const f = await fixture(t, socket => { for (const frame of frames) writeFrame(socket, frame); socket.end(); });
    await assert.rejects(new CooperativeToolClient(f.socketPath).execute(CALL), /cooperation_failed|cleanup_unconfirmed/);
  }
});
test('abort and deadline close the Unix connection; neither claims cleanup', async t => {
  let connected;
  const seen = new Promise(resolve => { connected = resolve; });
  let peer;
  const f = await fixture(t, socket => { peer = socket; connected(); });
  const controller = new AbortController();
  const pending = new CooperativeToolClient(f.socketPath).execute(CALL, {signal: controller.signal});
  await seen; const closed = once(peer, 'close'); controller.abort();
  await assert.rejects(pending, /cleanup_unconfirmed/); await closed;
  const second = await fixture(t, () => {});
  await assert.rejects(new CooperativeToolClient(second.socketPath, {timeoutMs: 20}).execute(CALL), /cleanup_unconfirmed/);
});
test('socket ownership mode and private parent are mandatory', async t => {
  const f = await fixture(t, socket => socket.end());
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(new CooperativeToolClient(f.socketPath).execute(CALL), /cooperation_failed/);
  await fs.chmod(f.directory, 0o700); await fs.chmod(f.socketPath, 0o666);
  await assert.rejects(new CooperativeToolClient(f.socketPath).execute(CALL), /cooperation_failed/);
  assert.equal(f.messages.length, 0);
});
test('custom tool accepts no model data, passes abort and returns unchanged structured result JSON', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/opencode-cooperative-tool.js'), 'utf8');
  const bridge = 'data:text/javascript,' + encodeURIComponent(`export default {async executeEnrolledSnapshot(id,{signal}) {
    if(id!==${JSON.stringify(CALL)} || !(signal instanceof AbortSignal)) throw Error('bad fixture');
    return ${JSON.stringify(VALUE)};
  }};`);
  const isolated = source.replace("'/opt/src/cooperative-tool-client.cjs'", JSON.stringify(bridge));
  const {delegate_public: tool} = await import('data:text/javascript,' + encodeURIComponent(isolated));
  assert.deepEqual(tool.args, {});
  const context = {callID: CALL, abort: new AbortController().signal};
  assert.deepEqual(JSON.parse(await tool.execute({}, context)), VALUE);
  await assert.rejects(tool.execute({question: 'model override', code: 'private code'}, context), /cooperation_failed/);
  await assert.rejects(tool.execute({}, {abort: context.abort}), /cooperation_failed/);
});
