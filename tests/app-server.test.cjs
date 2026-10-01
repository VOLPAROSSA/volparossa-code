// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {AppServer, MAX_LINE} = require('../src/app-server.cjs');

// Local protocol fixture, not a Codex binary or model-inference proof.
function fixture(options) {
  const input = new PassThrough(), output = new PassThrough();
  const sent = [];
  output.on('data', data => sent.push(JSON.parse(data.toString())));
  const client = new AppServer(input, output, options);
  const reply = (id, result) => input.write(JSON.stringify({id, result}) + '\n');
  return {input, sent, client, reply};
}
test('pinned app-server initialization, thread, turn and interrupt keep the VOLPAROSSA provider', async () => {
  const f = fixture();
  const init = f.client.initialize();
  assert.equal(f.sent[0].method, 'initialize');
  assert.equal(f.sent[0].params.capabilities.experimentalApi, false);
  f.reply(1, {userAgent: 'fixture'}); await init;
  assert.equal(f.sent[1].method, 'initialized');
  const started = f.client.startThread({model: 'volparossa-code', cwd: '/work'});
  assert.deepEqual(f.sent[2].params, {model: 'volparossa-code', modelProvider: 'volparossa',
    cwd: '/work', sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true});
  f.reply(2, {thread: {id: 't1'}}); await started;
  const turn = f.client.startTurn('t1', 'Review this public fixture.');
  assert.equal(f.sent[3].method, 'turn/start');
  f.reply(3, {turn: {id: 'r1'}}); await turn;
  const stop = f.client.interrupt('t1', 'r1');
  assert.deepEqual(f.sent[4].params, {threadId: 't1', turnId: 'r1'});
  f.reply(4, {}); await stop; f.client.close();
});
test('fragmented UTF-8 notifications and correlated responses are framed correctly', async () => {
  const f = fixture(); const notifications = [];
  f.client.on('notification', value => notifications.push(value));
  const pending = f.client.request('fixture', {});
  const bytes = Buffer.from(JSON.stringify({method: 'item/agentMessage/delta', params: {delta: 'hé'}}) + '\n');
  for (const byte of bytes) f.input.write(Buffer.from([byte]));
  f.reply(1, {}); await pending;
  assert.equal(notifications[0].params.delta, 'hé'); f.client.close();
});
test('requests for commands, writes, credentials or unknown tools never gain authority', () => {
  const f = fixture();
  for (const [id, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'account/chatgptAuthTokens/refresh', 'item/tool/call'].entries()) {
    f.input.write(JSON.stringify({id, method, params: {}}) + '\n');
  }
  assert.deepEqual(f.sent.slice(0, 2).map(item => item.result), [{decision: 'decline'}, {decision: 'decline'}]);
  assert.deepEqual(f.sent.slice(2).map(item => item.error.code), [-32601, -32601]); f.client.close();
});
test('invalid, oversized, wrong-correlation or ambiguous replies close the transport', async () => {
  for (const raw of [Buffer.from([0xff, 10]), Buffer.alloc(MAX_LINE + 1, 65), Buffer.from('{"id":9,"result":{}}\n'),
    Buffer.from('{"id":1,"result":{},"error":{}}\n'), Buffer.from('[]\n')]) {
    const f = fixture(); const pending = f.client.request('fixture', {});
    const refused = assert.rejects(pending, /rpc_closed/);
    f.input.write(raw); await refused; f.client.close();
  }
});
test('server errors are content-free and deadlines close pending work', async () => {
  const f = fixture(); const pending = f.client.request('fixture', {});
  f.input.write('{"id":1,"error":{"code":123,"message":"private source"}}\n');
  await assert.rejects(pending, error => error.message === 'app_server_rejected'); f.client.close();
  const timeout = fixture({timeoutMs: 10});
  await assert.rejects(timeout.client.request('fixture', {}), /rpc_closed/);
});
test('foreign model selection and pre-handshake thread creation fail locally', async () => {
  const f = fixture();
  await assert.rejects(f.client.startThread({model: 'gpt-model', cwd: '/work'}), /thread_scope/);
  assert.equal(f.sent.length, 0); f.client.close();
});
test('initialization is single-flight and a close-only stream rejects pending work', async () => {
  const f = fixture(); const first = f.client.initialize();
  await assert.rejects(f.client.initialize(), /already_initialized/);
  assert.equal(f.sent.length, 1); f.reply(1, {}); await first; f.client.close();
  const destroyed = fixture(); const pending = destroyed.client.request('fixture', {});
  const rejected = assert.rejects(pending, /rpc_closed/);
  destroyed.input.destroy(); await rejected;
});

test('exact explicit model and writable scope do not broaden default threads', async () => {
  const f = fixture({allowedModels: ['qwen3-0.6b-v1'], writableRoot: '/opt/work/project', commandApproval: () => false});
  const init = f.client.initialize(); f.reply(1, {}); await init;
  for (const [index, cwd, sandbox] of [[2, '/opt/work/project', 'workspace-write'], [3, '/elsewhere', 'read-only']]) {
    const thread = f.client.startThread({model: 'qwen3-0.6b-v1', cwd});
    assert.equal(f.sent.at(-1).params.sandbox, sandbox);
    assert.equal(f.sent.at(-1).params.approvalPolicy, 'untrusted');
    f.reply(index, {}); await thread;
  }
  await assert.rejects(f.client.startThread({model: 'qwen3-8b', cwd: '/opt/work/project'}), /thread_scope/);
  f.client.close();
  assert.throws(() => fixture({writableRoot: '/opt/work/project'}), /client_scope/);
});

test('optional command policy approves one command only; pre-initialize and other capabilities remain denied', async () => {
  let calls = 0;
  const f = fixture({commandApproval: params => { calls++; return params.allowed; }});
  const ask = (id, method, params) => f.input.write(JSON.stringify({id, method, params}) + '\n');
  ask('before', 'item/commandExecution/requestApproval', {allowed: true});
  assert.equal(calls, 0); assert.equal(f.sent.at(-1).result.decision, 'decline');
  const init = f.client.initialize(); f.reply(1, {}); await init;
  for (const allowed of [true, false, 'acceptForSession', {decision: 'accept'}]) {
    ask(String(calls), 'item/commandExecution/requestApproval', {allowed});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.at(-1).result.decision, allowed === true ? 'accept' : 'decline');
  }
  ask('file', 'item/fileChange/requestApproval', {allowed: true});
  assert.equal(f.sent.at(-1).result.decision, 'decline');
  ask('token', 'account/chatgptAuthTokens/refresh', {});
  assert.equal(f.sent.at(-1).error.code, -32601);
  assert.equal(calls, 4); f.client.close();
});

test('failed or late approval policies cannot grant authority', async () => {
  const f = fixture({commandApproval: () => { throw Error('synthetic policy failure'); }});
  const init = f.client.initialize(); f.reply(1, {}); await init;
  f.input.write('{"id":"deny","method":"item/commandExecution/requestApproval","params":{}}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.at(-1).result.decision, 'decline'); f.client.close();
  let finish;
  const late = fixture({commandApproval: () => new Promise(resolve => { finish = resolve; })});
  const initialized = late.client.initialize(); late.reply(1, {}); await initialized;
  late.input.write('{"id":"late","method":"item/commandExecution/requestApproval","params":{}}\n');
  await new Promise(resolve => setImmediate(resolve));
  late.client.close(); finish(true); await new Promise(resolve => setImmediate(resolve));
  assert(!late.sent.some(value => value.id === 'late'));
});
