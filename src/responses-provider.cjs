// SPDX-License-Identifier: GPL-3.0-only
// Explicit local Responses subset. No model, cloud client, scheduler or tool execution.
'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { PrivateConversation, validateConversation, expectedLimits, check, keys, text,
  identifier, object, fail } = require('./private-conversation.cjs');

const HTTP_BYTES = 524288;

// JSON.parse alone silently discards duplicate keys (including inside function
// argument strings). Preserve one unambiguous request without repair or truncation.
function parseJson(raw) {
  text(raw, HTTP_BYTES, false);
  let value;
  try { value = JSON.parse(raw); } catch { throw fail('invalid_json'); }
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  for (const token of tokens) {
    if (/^-?\d/.test(token)) {
      const number = Number(token);
      check(Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)), 'json_number_bound');
    }
  }
  let at = 0, nodes = 0;
  function visit(depth) {
    check(depth <= 32 && ++nodes <= 8192, 'json_bound');
    const token = tokens[at++];
    if (token === '{') {
      const seen = new Set();
      if (tokens[at] === '}') { at++; return; }
      do {
        const key = JSON.parse(tokens[at++]);
        check(!seen.has(key), 'duplicate_json_key');
        seen.add(key);
        check(tokens[at++] === ':', 'invalid_json');
        visit(depth + 1);
      } while (tokens[at++] === ',');
    } else if (token === '[') {
      if (tokens[at] === ']') { at++; return; }
      do { visit(depth + 1); } while (tokens[at++] === ',');
    }
  }
  visit(0);
  check(at === tokens.length, 'invalid_json');
  return value;
}

function content(value, role) {
  if (typeof value === 'string') return value;
  check(Array.isArray(value) && value.length >= 1 && value.length <= 128, 'unsupported_content');
  return value.map(part => {
    keys(part, ['type', 'text'], ['annotations', 'logprobs']);
    check(part.type === (role === 'assistant' ? 'output_text' : 'input_text') &&
      (part.annotations === undefined || Array.isArray(part.annotations) && !part.annotations.length) &&
      (part.logprobs === undefined || Array.isArray(part.logprobs) && !part.logprobs.length), 'unsupported_content');
    check(typeof part.text === 'string', 'unsupported_content');
    return part.text;
  }).join('\n\n');
}
function neutral(value, key, allowed) {
  check(value[key] === undefined || allowed.some(item => JSON.stringify(value[key]) === JSON.stringify(item)), 'unsupported_feature');
}
function normalizeTools(raw, caps) {
  check(Array.isArray(raw) && raw.length <= caps.max_tools, 'tool_bound');
  const result = [];
  function add(tool, namespace = null, description = '') {
    check(object(tool) && ['function', 'custom'].includes(tool.type), 'unsupported_tool');
    keys(tool, ['type', 'name', 'description', ...(tool.type === 'function' ? ['parameters'] : [])],
      ['namespace', 'strict', 'format', 'defer_loading']);
    check(namespace === null || tool.namespace === undefined, 'namespace_conflict');
    neutral(tool, 'strict', [false]);
    neutral(tool, 'defer_loading', [false]);
    if (tool.type === 'custom') neutral(tool, 'format', [{ type: 'text' }]);
    else check(tool.format === undefined, 'unsupported_feature');
    text(tool.description, caps.max_tool_description_bytes);
    const converted = { type: tool.type, name: tool.name, namespace: namespace ?? tool.namespace ?? null,
      description: description ? `Namespace ${namespace}: ${description}\n\n${tool.description}` : tool.description };
    if (tool.type === 'function') converted.parameters = tool.parameters;
    result.push(converted);
    check(result.length <= caps.max_tools, 'tool_bound');
  }
  for (const tool of raw) {
    if (tool?.type !== 'namespace') { add(tool); continue; }
    keys(tool, ['type', 'name', 'description', 'tools']);
    identifier(tool.name);
    text(tool.description, caps.max_tool_description_bytes, false);
    check(Array.isArray(tool.tools) && tool.tools.length >= 1 && tool.tools.length <= caps.max_tools, 'tool_bound');
    for (const member of tool.tools) add(member, tool.name, tool.description);
  }
  return result;
}

function toConversation(request, model, caps) {
  keys(request, ['model', 'instructions', 'input', 'store', 'stream'], ['tools', 'tool_choice', 'parallel_tool_calls',
    'reasoning', 'include', 'text', 'stream_options', 'max_output_tokens', 'prompt_cache_key', 'client_metadata', 'service_tier']);
  check(request.model === model && request.store === false && request.stream === true, 'unsupported_request');
  neutral(request, 'tool_choice', ['auto']);
  neutral(request, 'parallel_tool_calls', [false, true]); // Permission for several is not a requirement to propose several.
  if (request.reasoning != null) {
    keys(request.reasoning, [], ['effort', 'summary', 'context']);
    for (const [key, allowed] of [['effort', ['none']], ['summary', ['none']], ['context', ['current_turn']]]) {
      check(request.reasoning[key] === undefined || allowed.includes(request.reasoning[key]), 'unsupported_reasoning');
    }
  }
  // The pinned Codex builder always asks for this optional field, even on a
  // non-reasoning provider. There is no reasoning item/encrypted state to return.
  neutral(request, 'include', [[], ['reasoning.encrypted_content']]);
  neutral(request, 'text', [null, {}]);
  neutral(request, 'stream_options', [null, { include_usage: true }]);
  neutral(request, 'service_tier', [null, 'default']);
  // Explicitly accepted transport hints are discarded, never passed to a model,
  // cached, persisted, logged or used as authority. No cache hit is claimed.
  if (request.prompt_cache_key != null) text(request.prompt_cache_key, 512);
  if (request.client_metadata != null) {
    check(object(request.client_metadata) && Object.keys(request.client_metadata).length <= 32, 'metadata_bound');
    for (const [key, value] of Object.entries(request.client_metadata)) { text(key, 128); text(value, 16384, false); }
    check(Buffer.byteLength(JSON.stringify(request.client_metadata)) <= 32768, 'metadata_bound');
  }
  if (request.max_output_tokens !== undefined) check(request.max_output_tokens === caps.max_new_tokens, 'unsupported_output_budget');
  const tools = normalizeTools(request.tools ?? [], caps);
  const raw = typeof request.input === 'string' ? [{ type: 'message', role: 'user', content: request.input }] : request.input;
  check(Array.isArray(raw) && raw.length >= 1 && raw.length <= caps.max_history_items, 'history_bound');
  const history = [], calls = new Map();
  for (const item of raw) {
    check(object(item), 'unsupported_history');
    if (item.id !== undefined) text(item.id, 128);
    if (item.type === 'message' || item.type === undefined && item.role !== undefined) {
      keys(item, ['role', 'content'], ['type', 'id', 'status']);
      neutral(item, 'status', ['completed']);
      const roles = model === 'qwen3-0.6b-v1' ? ['user', 'assistant', 'system', 'developer'] : ['user', 'assistant'];
      check(roles.includes(item.role), 'unsupported_role');
      history.push({ type: 'message', role: item.role, text: content(item.content, item.role) });
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const custom = item.type === 'custom_tool_call';
      keys(item, ['type', 'call_id', 'name', custom ? 'input' : 'arguments'], ['id', 'namespace', 'status']);
      neutral(item, 'status', ['completed']);
      check(!calls.has(item.call_id), 'duplicate_call');
      const call = { type: item.type, call_id: item.call_id, name: item.name, namespace: item.namespace ?? null,
        ...(custom ? { input: item.input } : { arguments: parseJson(item.arguments) }) };
      calls.set(item.call_id, call);
      history.push(call);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      keys(item, ['type', 'call_id', 'output'], ['id', 'name', 'namespace']);
      const call = calls.get(item.call_id);
      check(call && item.type === (call.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output') &&
        (item.name === undefined || item.name === call.name) &&
        (item.namespace === undefined || item.namespace === call.namespace), 'tool_result_correlation');
      history.push({ type: 'tool_result', call_id: item.call_id, output: content(item.output, 'user') });
    } else throw fail('unsupported_history');
  }
  const conversation = { version: 1, visibility: 'private_local', instructions: request.instructions, history, tools };
  validateConversation(conversation, caps);
  return conversation;
}

function responseEvents(result) {
  // Caller receives this only after PrivateConversation validates terminal cleanup.
  const id = `resp_${randomBytes(16).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'response', created_at: created, model: result.model_profile, store: false,
    error: null, incomplete_details: null, output: [] };
  let sequence = 0;
  const events = [];
  const emit = (type, fields) => events.push({ type, sequence_number: sequence++, ...fields });
  emit('response.created', { response: { ...base, status: 'in_progress' } });
  const usage = { input_tokens: result.prompt_tokens, output_tokens: result.generated_tokens,
    total_tokens: result.prompt_tokens + result.generated_tokens,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  if (!result.turn_complete) {
    const reason = result.output.reason === 'token_limit' ? 'max_output_tokens' : result.output.reason;
    emit('response.incomplete', { response: { ...base, status: 'incomplete',
      incomplete_details: { reason }, usage } });
    return events;
  }
  const output = result.output;
  let item;
  if (output.type === 'assistant') {
    const itemId = `msg_${randomBytes(16).toString('hex')}`;
    const part = { type: 'output_text', text: output.text, annotations: [], logprobs: [] };
    item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] };
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0,
      part: { ...part, text: '' } });
    emit('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: output.text, logprobs: [] });
    emit('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: output.text, logprobs: [] });
    emit('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part });
  } else {
    const custom = output.type === 'custom_tool_call';
    item = { id: `${custom ? 'ctc' : 'fc'}_${randomBytes(16).toString('hex')}`, type: output.type,
      status: 'completed', call_id: output.call_id, name: output.name, namespace: output.namespace,
      ...(custom ? { input: output.input } : { arguments: JSON.stringify(output.arguments) }) };
    const field = custom ? 'input' : 'arguments';
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', [field]: '' } });
    const prefix = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
    emit(`${prefix}.delta`, { item_id: item.id, output_index: 0, delta: item[field] });
    emit(`${prefix}.done`, { item_id: item.id, output_index: 0, [field]: item[field] });
  }
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { ...base, status: 'completed', output: [item], usage,
    end_turn: output.type === 'assistant' } });
  return events;
}

function errorReply(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
  response.end(JSON.stringify({ error: { type: 'volparossa_provider_error', code,
    message: 'Local VOLPAROSSA provider rejected or could not complete this operation.' } }));
}
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= HTTP_BYTES, 'request_bound');
    chunks.push(chunk);
  }
  check(size > 0, 'invalid_request');
  try { return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch (error) { throw error.message?.startsWith('private_compute_') ? error : fail('invalid_json'); }
}

async function startResponsesProvider({ socketPath, model }) {
  expectedLimits(model);
  // Construction checks path syntax, but creates no connection or model process.
  new PrivateConversation(socketPath);
  const bearerToken = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${bearerToken}`);
  let host, active = null, closing = false;
  const observed = {submitted: 0, completed: 0, incomplete: 0, cleanup_confirmed: 0};
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000,
    keepAliveTimeout: 1000 }, (request, response) => {
    const received = Buffer.from(request.headers.authorization ?? '');
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
      errorReply(response, 401, 'unauthorized'); return;
    }
    if (request.headers.host !== host || request.headers.origin !== undefined || request.headers.referer !== undefined ||
        request.method !== 'POST' || request.url !== '/v1/responses' ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
        request.headers['content-encoding'] !== undefined || request.headers.expect !== undefined) {
      errorReply(response, 400, 'unsupported_request'); return;
    }
    if (closing || active) { errorReply(response, 503, 'busy'); return; }
    if (Number(request.headers['content-length'] ?? 0) > HTTP_BYTES) { errorReply(response, 413, 'request_bound'); return; }
    const controller = new AbortController();
    const client = new PrivateConversation(socketPath);
    const owner = { controller, client, done: null };
    active = owner;
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    owner.done = (async () => {
      try {
        const input = await readBody(request);
        if (controller.signal.aborted) throw fail('cancelled');
        const caps = await client.connect();
        check(caps.model_profile === model, 'model_mismatch');
        const conversation = toConversation(input, model, caps);
        observed.submitted++;
        const result = await client.submit(conversation, { signal: controller.signal });
        observed.cleanup_confirmed++;
        if (result.turn_complete) observed.completed++; else observed.incomplete++;
        if (controller.signal.aborted || response.destroyed) return;
        const events = responseEvents(result);
        // No partial model text or tool proposal leaves this process before the
        // core's terminal cleanup-confirmed result. SSE is protocol adaptation,
        // not a claim of token-by-token backend streaming.
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) {
        const code = error.message?.startsWith('private_compute_') ? error.code : 'provider_failed';
        errorReply(response, ['busy', 'cleanup_unconfirmed', 'socket_unavailable', 'execution_failed'].includes(code) ? 503 : 400, code);
      } finally {
        client.close();
        if (active === owner) active = null;
      }
    })();
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  return { baseUrl: `http://${host}/v1`, bearerToken,
    // Content-free lifecycle counters for an explicitly started local owner.
    get observations() { return Object.freeze({...observed}); },
    async close() {
      closing = true;
      const owner = active;
      owner?.controller.abort();
      server.closeAllConnections();
      await owner?.done;
      await new Promise(resolve => server.close(resolve));
    } };
}

module.exports = { startResponsesProvider, toConversation, responseEvents, parseJson };
