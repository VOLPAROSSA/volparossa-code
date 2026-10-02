// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const {readFrames, writeFrame} = require('../src/opencode-bridge.cjs');
const {startCooperativeTool} = require('../src/cooperative-tool-server.cjs');

async function request(socketPath, value, connected = () => {}) {
  const socket = net.createConnection(socketPath);
  return new Promise((resolve, reject) => {
    let result;
    const unbind = readFrames(socket, frame => { result = frame; }, reject);
    socket.once('connect', () => { writeFrame(socket, value); connected(socket); });
    socket.once('error', reject);
    socket.once('close', () => { unbind(); resolve(result); });
  });
}

test('proxy invokes only the opaque owner snapshot and preserves original tool result', async () => {
  const snapshot = Object.freeze({}), observed = [];
  const output = {tool_call_id: 'call_one', core_task_id: 'a'.repeat(32),
    visibility: 'public_cooperative', result: {answer_complete: false, output: {text: 'Original partial result'}}};
  class Delegate {
    constructor(socket) { assert.equal(socket, '/owner/public.sock'); }
    async connect() { observed.push('connect'); }
    async execute(value) {
      assert.equal(value.snapshot, snapshot); assert.equal(value.tool_call_id, 'call_one');
      assert.deepEqual(Object.keys(value).sort(), ['signal', 'snapshot', 'tool_call_id']);
      observed.push('execute'); return output;
    }
    async close() { observed.push('close'); }
  }
  const server = await startCooperativeTool({socketPath: '/owner/public.sock', snapshot}, {Delegate});
  try {
    assert.deepEqual(observed, []);
    assert.equal((await fs.stat(server.socketPath)).mode & 0o777, 0o600);
    assert.deepEqual(await request(server.socketPath, {type: 'execute', call_id: 'call_one'}), {type: 'result', value: output});
    assert.equal(await request(server.socketPath, {type: 'execute', call_id: 'call_two'}), undefined);
    assert.deepEqual(observed, ['connect', 'execute']);
  } finally { await server.close(); }
  assert.deepEqual(observed, ['connect', 'execute', 'close']);
  assert.deepEqual(server.observations, {submitted: 1, completed: 1, cleanup_confirmed: true});
  await assert.rejects(fs.stat(server.socketPath), {code: 'ENOENT'});
});

test('model-supplied text, paths or forged public declarations cannot be exported', async () => {
  class Delegate {
    async connect() { assert.fail('no core connection'); }
    async close() {}
  }
  const server = await startCooperativeTool({socketPath: '/owner/public.sock', snapshot: {}}, {Delegate});
  try {
    for (const addition of [{context: 'private source'}, {path: '/workspace/secret'}, {public_content: true}]) {
      assert.equal(await request(server.socketPath, {type: 'execute', call_id: 'call_one', ...addition}), undefined);
    }
    assert.equal(server.observations.submitted, 0);
  } finally { await server.close(); }
});

test('tool disconnect cancels and owner close awaits the same core job cleanup', async () => {
  let started, release, cancelled = false, joined = false;
  const ready = new Promise(resolve => { started = resolve; });
  class Delegate {
    async connect() {}
    async execute({signal}) {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled = true;
          release = () => { joined = true; reject(Error('cancelled')); };
        }, {once: true});
      });
    }
    async close() { assert.equal(joined, true); }
  }
  const server = await startCooperativeTool({socketPath: '/owner/public.sock', snapshot: {}}, {Delegate});
  let socket;
  const pending = request(server.socketPath, {type: 'execute', call_id: 'call_one'}, value => { socket = value; });
  await ready; socket.destroy(); await pending;
  const stopping = server.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true); assert.equal(joined, false);
  release(); await stopping;
  assert.equal(server.observations.cleanup_confirmed, true);
});

test('unconfirmed remote cleanup prevents a successful owner close', async () => {
  class Delegate {
    async connect() {}
    async execute() { throw Object.assign(Error('cleanup_unconfirmed'), {code: 'cleanup_unconfirmed'}); }
    async close() {}
  }
  const server = await startCooperativeTool({socketPath: '/owner/public.sock', snapshot: {}}, {Delegate});
  const outcome = await request(server.socketPath, {type: 'execute', call_id: 'call_one'});
  assert.deepEqual(outcome, {type: 'error', code: 'cleanup_unconfirmed'});
  await assert.rejects(server.close(), /cleanup_unconfirmed/);
  assert.equal(server.observations.cleanup_confirmed, false);
});
