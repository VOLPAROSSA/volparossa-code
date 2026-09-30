// SPDX-License-Identifier: GPL-3.0-only
// Real HTTP + Unix sockets, synthetic protocol peer; not model/native coding proof.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { startResponsesProvider, toConversation, parseJson } = require('../src/responses-provider.cjs');
const { caps, input, result, reply, fixture } = require('./conversation-fixture.cjs');

function request(model = 'smollm2-360m-v1') {
  return { model, instructions: 'Answer with a bounded truthful proposal.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic fixture.' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: true, reasoning: {}, store: false, stream: true,
    include: ['reasoning.encrypted_content'], prompt_cache_key: 'fixture-no-cache', text: null,
    client_metadata: { session_id: 'fixture-no-telemetry', thread_id: 'fixture' } };
}
async function start(t, handler, model = 'smollm2-360m-v1') {
  const f = await fixture(t, handler, caps(model));
  const provider = await startResponsesProvider({ socketPath: f.socketPath, model });
  // Register explicitly in the parent fixture cleanup order. Closing the HTTP
  // listener is awaited in each test before the synthetic Unix backend closes.
  return { ...f, provider };
}
function send(provider, value, headers = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = http.request(`${provider.baseUrl}/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.bearerToken}`,
        'content-length': Buffer.byteLength(body), ...headers } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data }));
    });
    req.on('error', reject); req.end(body);
  });
}
function events(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  const rows = response.body.trim().split('\n\n').map(block => {
    const [type, data] = block.split('\n');
    const value = JSON.parse(data.slice(6));
    assert.equal(type, `event: ${value.type}`);
    return value;
  });
  assert.deepEqual(rows.map(value => value.sequence_number), rows.map((_value, index) => index));
  return rows;
}

test('explicit loopback provider authenticates before IPC and retains no default/cloud listener', async t => {
  const f = await start(t, () => assert.fail('no generation expected'));
  try {
    assert.match(f.provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(f.provider.bearerToken.length, 43);
    assert.equal(f.requests.length, 0);
    for (const headers of [{ authorization: 'Bearer wrong' }, { origin: 'https://untrusted.invalid' },
      { referer: 'https://untrusted.invalid/' }, { host: 'attacker.invalid' }, { 'content-encoding': 'gzip' }]) {
      const response = await send(f.provider, request(), headers);
      assert.ok([400, 401].includes(response.status));
    }
    assert.equal(f.requests.length, 0);
  } finally { await f.provider.close(); }
});

test('native-shaped request streams only the exact final answer after cleanup, with real token counts', async t => {
  let finish, admitted;
  const ready = new Promise(resolve => { admitted = resolve; });
  const original = result();
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted');
    finish = () => reply(socket, message, 'result', { result: original });
    admitted();
  });
  try {
    let settled = false;
    const pending = send(f.provider, request()); pending.then(() => { settled = true; });
    await ready;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation']);
    const forwarded = f.requests[1].operation.conversation;
    assert.equal(forwarded.instructions, request().instructions);
    assert.equal(forwarded.history[0].text, 'Synthetic fixture.');
    assert.ok(!JSON.stringify(forwarded).includes('fixture-no-cache'));
    assert.ok(!JSON.stringify(forwarded).includes('fixture-no-telemetry'));
    finish();
    const response = await pending;
    const rows = events(response);
    assert.equal(rows[0].type, 'response.created');
    assert.equal(rows.at(-1).type, 'response.completed');
    assert.equal(rows.at(-1).response.output[0].content[0].text, original.output.text);
    assert.deepEqual(rows.at(-1).response.usage, { input_tokens: 10, output_tokens: 20, total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
    assert.equal(rows.at(-1).response.end_turn, true);
    const followup = request();
    followup.input.push(rows.at(-1).response.output[0], { type: 'message', role: 'user', content: 'Continue.' });
    assert.equal(toConversation(followup, followup.model, caps()).history[1].text, original.output.text);
  } finally { await f.provider.close(); }
});

test('namespaced function and literal custom proposals preserve IDs and never execute tools', async t => {
  for (const custom of [false, true]) {
    const proposed = { type: custom ? 'custom_tool_call' : 'function_call', call_id: 'fresh-call',
      name: custom ? 'patch' : 'read', namespace: 'workspace',
      ...(custom ? { input: 'literal synthetic patch; do not execute' } : { arguments: { file: 'demo.rs' } }) };
    const f = await start(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(proposed) });
    });
    try {
      const body = request();
      body.tools = [{ type: 'namespace', name: 'workspace', description: 'Only owner-approved inputs.', tools: [
        { type: custom ? 'custom' : 'function', name: proposed.name, description: 'Fixture tool.',
          ...(custom ? { format: { type: 'text' } } : { strict: false, parameters: { type: 'object' } }) },
      ] }];
      const rows = events(await send(f.provider, body));
      const answer = rows.at(-1).response.output[0];
      assert.equal(answer.type, proposed.type); assert.equal(answer.namespace, proposed.namespace);
      assert.equal(answer.call_id, proposed.call_id);
      assert.equal(rows.at(-1).response.end_turn, false);
      if (custom) assert.equal(answer.input, proposed.input);
      else assert.deepEqual(JSON.parse(answer.arguments), proposed.arguments);
      const history = structuredClone(body);
      history.input.push(answer, { type: custom ? 'custom_tool_call_output' : 'function_call_output',
        call_id: answer.call_id, output: [{ type: 'input_text', text: 'user-approved fixture result' }] });
      const mapped = toConversation(history, body.model, caps());
      assert.equal(mapped.history.at(-1).call_id, answer.call_id);
      assert.match(mapped.tools[0].description, /Only owner-approved inputs/);
      assert.equal(f.requests.length, 2);
    } finally { await f.provider.close(); }
  }
});

test('all incomplete core results emit response.incomplete without output or completed event', async t => {
  for (const reason of ['token_limit', 'wire_truncated', 'invalid_output']) {
    const f = await start(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result({ type: 'incomplete', reason }) });
    });
    try {
      const rows = events(await send(f.provider, request()));
      assert.deepEqual(rows.map(row => row.type), ['response.created', 'response.incomplete']);
      assert.equal(rows.at(-1).response.status, 'incomplete');
      assert.deepEqual(rows.at(-1).response.output, []);
      assert.notEqual(rows.at(-1).response.incomplete_details.reason, 'interrupted');
    } finally { await f.provider.close(); }
  }
});

test('invalid history, grammar, reasoning and unknown features reject without a submit or truncation', async t => {
  const f = await start(t, () => assert.fail('must not submit'));
  try {
    for (const change of [
      { previous_response_id: 'hidden-state' }, { reasoning: { effort: 'high' } }, { store: true },
      { input: [{ type: 'input_image', image_url: 'private' }] }, { instructions: 'x'.repeat(4097) },
      { tools: [{ type: 'function', name: 'bad', strict: true, description: 'No claimed validation.', parameters: { type: 'object' } }] },
      { tools: [{ type: 'custom', name: 'bad', description: 'No grammar.', format: { type: 'grammar', syntax: 'lark', definition: 'bad' } }] },
      { input: [{ type: 'function_call_output', call_id: 'missing', output: 'private' }] },
      { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'private' }] }] },
    ]) {
      const response = await send(f.provider, { ...request(), ...change });
      assert.equal(response.status, 400);
      assert.ok(!response.body.includes('private'));
    }
    assert.ok(f.requests.every(row => row.operation.type === 'conversation_capabilities'));
  } finally { await f.provider.close(); }
});

test('duplicate keys, unsafe numbers and depth overflow are rejected explicitly', () => {
  for (const value of ['{"same":1,"same":2}', '{"same":1,"\\u0073ame":2}',
    '{"value":9007199254740993}', '{"value":1e999}', '['.repeat(34) + '0' + ']'.repeat(34)]) {
    assert.throws(() => parseJson(value));
  }
  assert.deepEqual(parseJson('{"quoted":"{not: syntax}","nested":[null,true,1.25]}'),
    { quoted: '{not: syntax}', nested: [null, true, 1.25] });
});

test('unknown cleanup prevents any SSE and returns a closed error without raw model text', async t => {
  const invalid = result({ type: 'assistant', text: 'private-canary-never-export' });
  invalid.cleanup.complete = false;
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: invalid });
  });
  try {
    const response = await send(f.provider, request());
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'cleanup_unconfirmed');
    assert.ok(!response.body.includes('private-canary'));
    assert.ok(!response.body.includes('response.completed'));
  } finally { await f.provider.close(); }
});

test('HTTP disconnect cancels exact core task, holds single slot until terminal cleanup', async t => {
  let admitted, acknowledge, task;
  const started = new Promise(resolve => { admitted = resolve; });
  const cancelled = new Promise(resolve => { acknowledge = resolve; });
  const f = await start(t, (socket, message) => {
    if (message.operation.type === 'submit_conversation') { task = message; reply(socket, message, 'admitted'); admitted(); }
    else {
      assert.equal(message.operation.task_id, task.id);
      reply(socket, message, 'cancel_requested', { task_id: task.id });
      acknowledge(() => reply(socket, task, 'error', { code: 'cancelled' }));
    }
  });
  try {
    const body = JSON.stringify(request());
    const req = http.request(`${f.provider.baseUrl}/responses`, { method: 'POST', headers: {
      authorization: `Bearer ${f.provider.bearerToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } });
    req.on('error', () => {}); req.end(body);
    await started; req.destroy();
    const finish = await cancelled;
    assert.equal((await send(f.provider, request())).status, 503);
    finish();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation', 'cancel']);
  } finally { await f.provider.close(); }
});

test('larger Qwen profile transmits full instructions beyond legacy frame without widening Q&A', async t => {
  const model = 'qwen3-0.6b-v1';
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(undefined, model) });
  }, model);
  try {
    const body = request(model); body.instructions = 'Bounded native fixture instruction. '.repeat(1500);
    body.input.unshift({ type: 'message', role: 'developer', content: [
      { type: 'input_text', text: 'Exact developer instructions.' },
      { type: 'input_text', text: 'Keep private workspace context private.' },
    ] });
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 32768);
    const rows = events(await send(f.provider, body));
    assert.equal(rows.at(-1).response.model, model);
    assert.equal(f.requests[1].operation.conversation.instructions, body.instructions);
    assert.deepEqual(f.requests[1].operation.conversation.history[0], { type: 'message', role: 'developer',
      text: 'Exact developer instructions.\n\nKeep private workspace context private.' });
    assert.throws(() => toConversation({ ...body, model: 'smollm2-360m-v1' }, 'smollm2-360m-v1', caps()));
  } finally { await f.provider.close(); }
});
