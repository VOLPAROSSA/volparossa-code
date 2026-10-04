// SPDX-License-Identifier: GPL-3.0-only
// Actual same-owner Unix framing with synthetic core replies. These contracts
// are NOT evidence that models or remote peers executed the fixture tasks.
'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {CooperativeDelegation, createPublicSnapshot} = require('../src/cooperative-delegation.cjs');
const {frame, reply} = require('./conversation-fixture.cjs');

const PUBLIC = {question: 'Explain this explicitly public example.', context: 'pub fn answer() -> u8 { 42 }',
  license: 'GPL-3.0-only', public_content: true, rights_confirmed: true};
function caps() {
  return {visibility: 'public_cooperative', network_access: true, private_data_supported: false,
    public_cache: true, training: false, cloud_fallback: false, retained_public_receipts: true,
    remote_erasure_guaranteed: false, model_execution_proven: false, model_profile: 'smollm2-135m-v1',
    max_question_bytes: 512, max_context_bytes: 4096, max_request_bytes: 32768, max_response_bytes: 65536,
    execution_slots: 1, max_connections: 8, max_retained_tasks: 32, retained_bytes_admission_limit: 268435456,
    max_seconds: 600, max_task_seconds: 1800, quarantined: false};
}
function result() {
  return {answer_complete: true, answer_status: 'complete', output: {text: 'Public fixture answer.'},
    provider_keys: ['a'.repeat(64)], selected_provider_keys: ['a'.repeat(64), 'b'.repeat(64)],
    joining: 'single_source_answer', execution_complete: true, package_count: 1, total_parts: 1,
    synthesis_levels: 0, source_manifest_id: 'c'.repeat(64), remote_cleanup_confirmed: true,
    cleanup: {complete: true}, retained_public_receipts: true,
    model_answer_correctness_proven: false, semantic_completeness_proven: false};
}
async function fixture(t, handler, capabilities = caps()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-public-code-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'public.sock'), sockets = new Set(), requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      assert.ok(pending.length <= 65536);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE()) {
        const size = pending.readUInt32BE(); assert.ok(size > 0 && size <= 32768);
        const message = JSON.parse(pending.subarray(4, 4 + size)); pending = pending.subarray(4 + size);
        requests.push(message);
        if (message.operation.type === 'capabilities') reply(socket, message, 'capabilities', {capabilities});
        else handler(socket, message);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  const client = new CooperativeDelegation(socketPath);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await client.close().catch(() => {}); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, {recursive: true});
  });
  return {client, requests, socketPath};
}
const complete = (socket, request) => {
  reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: result()});
};

test('snapshot explicitly enrolls exact public question and source without exporting mutable content', () => {
  const token = createPublicSnapshot(PUBLIC);
  assert.equal(Object.isFrozen(token), true);
  assert.deepEqual(Object.keys(token), ['visibility', 'id']);
  assert.ok(!JSON.stringify(token).includes(PUBLIC.context));
  for (const change of [{public_content: false}, {rights_confirmed: false}, {license: 'proprietary'},
    {question: '€'.repeat(171)}, {context: 'x'.repeat(4097)}, {question: ' '}, {context: '\0'},
    {context: '\ud800'}, {private_history: 'not enrolled'}, {model: 'peer-selected'}, {context: ''}]) {
    assert.throws(() => createPublicSnapshot({...PUBLIC, ...change}));
  }
});

test('real framed submission preserves OpenCode ID and unchanged complete core provenance', async t => {
  const f = await fixture(t, complete); await f.client.connect();
  const source = {...PUBLIC}, snapshot = createPublicSnapshot(source);
  source.context = 'PRIVATE_CHANGED_AFTER_ENROLLMENT'; source.question = 'changed';
  const value = await f.client.execute({tool_call_id: 'call-public-1', snapshot});
  assert.equal(value.tool_call_id, 'call-public-1'); assert.equal(value.visibility, 'public_cooperative');
  const sent = f.requests.find(message => message.operation.type === 'submit');
  assert.equal(value.core_task_id, sent.id);
  assert.deepEqual(sent.operation, {type: 'submit', ...PUBLIC});
  assert.deepEqual(value.result, result());
  assert.equal(value.result.provider_keys.length, 1); // Selected pair does NOT become a claim of two workers.
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_CHANGED_AFTER_ENROLLMENT'), false);
  await f.client.close();
});

test('opaque snapshot cannot be forged, replayed or supplemented with private history', async t => {
  const f = await fixture(t, complete); await f.client.connect();
  const snapshot = createPublicSnapshot(PUBLIC);
  for (const call of [{tool_call_id: 'id', snapshot: {...snapshot}},
    {tool_call_id: 'id', snapshot, history: 'PRIVATE_PROMPT'}, {tool_call_id: '../path', snapshot}]) {
    await assert.rejects(f.client.execute(call));
  }
  assert.equal(f.requests.length, 1);
  await f.client.execute({tool_call_id: 'exact', snapshot});
  await assert.rejects(f.client.execute({tool_call_id: 'again', snapshot}), {code: 'public_snapshot_required'});
  assert.equal(f.requests.filter(message => message.operation.type === 'submit').length, 1);
});

test('private service capabilities, cloud/private claims and incompatible bounds cannot be adopted', async t => {
  for (const change of [{visibility: 'private_local'}, {private_data_supported: true}, {training: true},
    {cloud_fallback: true}, {model_execution_proven: true}, {remote_erasure_guaranteed: true},
    {max_context_bytes: 8192}, {max_task_seconds: 7201}, {unreviewed_extra_field: true}]) {
    const f = await fixture(t, () => assert.fail('no submission'), {...caps(), ...change});
    await assert.rejects(f.client.connect()); assert.equal(f.requests.length, 1);
  }
});

test('quarantine and cancelled-before-submit prevent publication', async t => {
  const f = await fixture(t, () => assert.fail('quarantine'), {...caps(), quarantined: true});
  await f.client.connect();
  await assert.rejects(f.client.execute({tool_call_id: 'call', snapshot: createPublicSnapshot(PUBLIC)}),
    {code: 'cleanup_unconfirmed'});
  assert.equal(f.requests.length, 1);
  const g = await fixture(t, () => assert.fail('cancelled')); await g.client.connect();
  const signal = AbortSignal.abort();
  await assert.rejects(g.client.execute({tool_call_id: 'call', snapshot: createPublicSnapshot(PUBLIC), signal}), {code: 'cancelled'});
  assert.equal(g.requests.length, 1);
});

test('incomplete answer remains incomplete with original text and provenance', async t => {
  const original = {...result(), answer_complete: false, answer_status: 'incomplete', execution_complete: false,
    output: {text: ''}, provider_keys: [], joining: 'awaiting_fragments_before_peer_synthesis'};
  const f = await fixture(t, (socket, request) => {
    reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: original});
  });
  await f.client.connect();
  const value = await f.client.execute({tool_call_id: 'partial', snapshot: createPublicSnapshot(PUBLIC)});
  assert.deepEqual(value.result, original);
});

test('corrupt core result never emits an apparently successful tool output', async t => {
  for (const change of [{cleanup: {complete: false}}, {remote_cleanup_confirmed: false},
    {provider_keys: ['d'.repeat(64)]}, {selected_provider_keys: ['a'.repeat(64), 'a'.repeat(64)]},
    {model_answer_correctness_proven: true}, {answer_status: 'incomplete'},
    {execution_complete: false}, {source_manifest_id: '0'.repeat(64)}, {output: {text: '\0'}}]) {
    const f = await fixture(t, (socket, request) => {
      reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: {...result(), ...change}});
    });
    await f.client.connect();
    await assert.rejects(f.client.execute({tool_call_id: 'corrupt', snapshot: createPublicSnapshot(PUBLIC)}));
  }
});

test('cancellation is exact and holds the slot until terminal cleanup, not its acknowledgement', async t => {
  let original, admitted, cancelled, terminal;
  const started = new Promise(resolve => { admitted = resolve; });
  const ack = new Promise(resolve => { cancelled = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit') {
      original = request; reply(socket, request, 'admitted'); admitted();
    } else {
      assert.deepEqual(request.operation, {type: 'cancel', task_id: original.id});
      reply(socket, request, 'cancel_requested', {task_id: original.id});
      terminal = () => reply(socket, original, 'error', {code: 'cancelled'}); cancelled();
    }
  });
  await f.client.connect(); const abort = new AbortController(); let settled = false;
  const pending = f.client.execute({tool_call_id: 'cancel-me', snapshot: createPublicSnapshot(PUBLIC), signal: abort.signal});
  pending.catch(() => { settled = true; }); await started; abort.abort(); await ack;
  await new Promise(setImmediate); assert.equal(settled, false);
  await assert.rejects(f.client.execute({tool_call_id: 'other', snapshot: createPublicSnapshot(PUBLIC)}), {code: 'busy'});
  terminal(); await assert.rejects(pending, {code: 'cancelled'});
  await f.client.close();
});

test('close awaits real terminal cancellation and does not equate EOF with cleanup', async t => {
  let admitted, cancelled, finish, original;
  const started = new Promise(resolve => { admitted = resolve; });
  const ack = new Promise(resolve => { cancelled = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit') { original = request; reply(socket, request, 'admitted'); admitted(); }
    else { reply(socket, request, 'cancel_requested', {task_id: original.id});
      finish = () => reply(socket, original, 'error', {code: 'cancelled'}); cancelled(); }
  });
  await f.client.connect();
  const pending = f.client.execute({tool_call_id: 'closing', snapshot: createPublicSnapshot(PUBLIC)});
  pending.catch(() => {}); await started; let closed = false;
  const closing = f.client.close().then(() => { closed = true; });
  await ack; await new Promise(setImmediate); assert.equal(closed, false);
  finish(); await closing; await assert.rejects(pending, {code: 'cancelled'});
  await assert.rejects(f.client.connect(), {code: 'closed'});
});

test('remote disconnect leaves cleanup uncertain and is never retried to another service', async t => {
  const f = await fixture(t, (socket, request) => { reply(socket, request, 'admitted'); socket.end(); });
  await f.client.connect();
  const snapshot = createPublicSnapshot(PUBLIC);
  await assert.rejects(f.client.execute({tool_call_id: 'disconnect', snapshot}), {code: 'cleanup_unconfirmed'});
  assert.equal(f.requests.filter(message => message.operation.type === 'submit').length, 1);
  await assert.rejects(f.client.execute({tool_call_id: 'retry', snapshot}));
  await assert.rejects(f.client.close(), {code: 'cleanup_unconfirmed'});
});

test('same-owner socket permission boundary rejects a publicly accessible endpoint', async t => {
  const f = await fixture(t, complete); await fs.chmod(f.socketPath, 0o666);
  await assert.rejects(f.client.connect(), {code: 'socket_ownership'}); assert.equal(f.requests.length, 0);
});

test('out-of-order or unknown correlation never becomes a result', async t => {
  for (const response of ['missing_admission', 'wrong_id']) {
    const f = await fixture(t, (socket, request) => {
      if (response === 'wrong_id') reply(socket, request, 'admitted');
      socket.write(frame({version: 1, id: response === 'wrong_id' ? 'f'.repeat(32) : request.id,
        event: 'result', result: result()}));
    });
    await f.client.connect();
    await assert.rejects(f.client.execute({tool_call_id: 'bad-correlation', snapshot: createPublicSnapshot(PUBLIC)}));
  }
});
