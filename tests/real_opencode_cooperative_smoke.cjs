// SPDX-License-Identifier: GPL-3.0-only
// Explicit actual OpenCode + production cooperative bridge trial. Both model
// services use SYNTHETIC replies: this is not remote peer or inference evidence.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {OpenCodeRuntime} = require('../src/opencode-runtime.cjs');
const {createPublicSnapshot} = require('../src/cooperative-delegation.cjs');
const {caps, result, reply, fixture} = require('./conversation-fixture.cjs');
const MODEL = 'qwen3-0.6b-v1';
const SENTINEL = 'PRIVATE_NATIVE_COOP_SENTINEL_83bb724d';
const CALL = 'native-public-delegation-1', CHECK_CALL = 'native-isolation-check-1';
const PUBLIC = {question: 'What does this explicitly public function return?',
  context: 'pub fn answer() -> u8 { 42 }', license: 'GPL-3.0-only', public_content: true, rights_confirmed: true};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function publicCaps() {
  return {visibility: 'public_cooperative', network_access: true, private_data_supported: false,
    public_cache: true, training: false, cloud_fallback: false, retained_public_receipts: true,
    remote_erasure_guaranteed: false, model_execution_proven: false, model_profile: 'smollm2-135m-v1',
    max_question_bytes: 512, max_context_bytes: 4096, max_request_bytes: 32768, max_response_bytes: 65536,
    execution_slots: 1, max_connections: 8, max_retained_tasks: 32, retained_bytes_admission_limit: 268435456,
    max_seconds: 600, max_task_seconds: 1800, quarantined: false};
}
function publicResult(complete) {
  return {answer_complete: complete, answer_status: complete ? 'complete' : 'incomplete',
    output: {text: complete ? 'Synthetic public answer: 42.' : ''},
    provider_keys: complete ? ['a'.repeat(64)] : [], selected_provider_keys: ['a'.repeat(64), 'b'.repeat(64)],
    joining: complete ? 'single_source_answer' : 'awaiting_fragments_before_peer_synthesis',
    execution_complete: complete, package_count: 1, total_parts: 1, synthesis_levels: 0,
    source_manifest_id: 'c'.repeat(64), remote_cleanup_confirmed: true, cleanup: {complete: true},
    retained_public_receipts: true, model_answer_correctness_proven: false, semantic_completeness_proven: false};
}
async function publicCore(cleanups, complete) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-native-public-core-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'public.sock'), sockets = new Set(), requests = [];
  let failure, submitId;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      try {
        pending = Buffer.concat([pending, chunk]); assert.ok(pending.length <= 32772);
        while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE()) {
          const length = pending.readUInt32BE(); assert.ok(length > 0 && length <= 32768);
          const request = JSON.parse(pending.subarray(4, 4 + length)); pending = pending.subarray(4 + length);
          requests.push(request); assert.ok(requests.length <= 2, 'no additional operations/retries');
          if (request.operation.type === 'capabilities') {
            reply(socket, request, 'capabilities', {capabilities: publicCaps()});
          } else {
            assert.equal(submitId, undefined, 'single enrolled submission');
            assert.deepEqual(request.operation, {type: 'submit', ...PUBLIC}); submitId = request.id;
            assert.equal(JSON.stringify(request).includes(SENTINEL), false);
            reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: publicResult(complete)});
          }
        }
      } catch (error) { failure = error; socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await fs.rm(directory, {recursive: true});
  });
  return {socketPath, requests, get failure() { return failure; }, get submitId() { return submitId; }};
}

async function scenario(config, complete) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-opencode-coop-project-'));
  await fs.chmod(project, 0o700);
  await fs.writeFile(path.join(project, 'private.txt'), SENTINEL, {mode: 0o600});
  const cleanups = [], approvals = []; let runtime, modelError, privateRequests = 0, stage = 0, returned;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 90000);
  try {
    const publicService = await publicCore(cleanups, complete);
    assert.match(publicService.socketPath, /^\/tmp\/vp-native-public-core-[A-Za-z0-9]+\/public\.sock$/);
    // This deliberately approved native command proves the raw public-core path
    // is absent inside the namespace while the limited proxy socket is present.
    const command = `test ! -e '${publicService.socketPath}' && test -S /opt/core/cooperative.sock `
      + `&& test -f /workspace/private.txt && printf 'raw-public-socket-absent\\n' > isolation.txt`;
    const answer = complete ? 'Synthetic public delegation returned a complete result.'
      : 'Synthetic public delegation is incomplete; no complete answer is claimed.';
    const privateService = await fixture({after: action => cleanups.push(action)}, (socket, request) => {
      try {
        assert.equal(request.operation.type, 'submit_conversation'); assert.ok(++privateRequests <= 8);
        const input = request.operation.conversation; let output;
        if (input.tools.length) {
          assert.ok(input.tools.some(tool => tool.name === 'volparossa_delegate_public'), 'trusted custom tool loaded');
          assert.ok(JSON.stringify(input.history).includes(SENTINEL), 'private history remains on private lane');
          if (stage === 0) {
            stage++;
            output = {type: 'function_call', call_id: CHECK_CALL, namespace: null, name: 'bash', arguments: {
              command, description: 'Check the disposable namespace and record its public-socket isolation.', timeout: 10000,
            }};
          } else if (stage === 1) {
            assert.ok(input.history.some(item => item.type === 'tool_result' && item.call_id === CHECK_CALL));
            stage++;
            output = {type: 'function_call', call_id: CALL, namespace: null,
              name: 'volparossa_delegate_public', arguments: {}};
          } else {
            assert.equal(stage, 2, 'one bounded coding turn'); stage++;
            const call = input.history.find(item => item.type === 'function_call' && item.call_id === CALL);
            assert.equal(call?.name, 'volparossa_delegate_public'); assert.deepEqual(call.arguments, {});
            const tool = input.history.find(item => item.type === 'tool_result' && item.call_id === CALL);
            assert.ok(tool, 'original native tool call identity returns in the follow-up');
            returned = JSON.parse(tool.output);
            assert.equal(returned.tool_call_id, CALL); assert.equal(returned.core_task_id, publicService.submitId);
            assert.equal(returned.visibility, 'public_cooperative'); assert.deepEqual(returned.result, publicResult(complete));
            output = {type: 'assistant', text: answer};
          }
        } else output = {type: 'assistant', text: 'Synthetic cooperative smoke'};
        reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: result(output, MODEL)});
      } catch (error) { modelError = error; socket.destroy(); abort.abort(); }
    }, caps(MODEL));
    runtime = await OpenCodeRuntime.start({...config, socketPath: privateService.socketPath}, {workspace: project,
      cooperation: {socketPath: publicService.socketPath, snapshot: createPublicSnapshot(PUBLIC)}});
    const observed = await runtime.run(`The private sentinel is ${SENTINEL}. Never share it. `
      + 'Check the disposable namespace, then use the enrolled public cooperative tool exactly once.', {
      signal: abort.signal, approve: proposal => {
        approvals.push(proposal);
        return proposal.permission === 'bash' && proposal.command === command && proposal.directory === '/workspace';
      },
    });
    if (modelError) throw modelError; if (publicService.failure) throw publicService.failure;
    assert.equal(observed.text, answer); assert.equal(observed.nativeTurnCompleted, true);
    assert.equal(observed.taskVerified, false); assert.equal(observed.commands, 1); assert.equal(approvals.length, 1);
    assert.equal(stage, 3); assert.equal(publicService.requests.length, 2);
    assert.equal(await fs.readFile(path.join(project, 'isolation.txt'), 'utf8'), 'raw-public-socket-absent\n');
    assert.equal(await fs.readFile(path.join(project, 'private.txt'), 'utf8'), SENTINEL);
    assert.equal(JSON.stringify(publicService.requests).includes(SENTINEL), false);
    const observations = runtime.publicDelegation;
    await runtime.close(); runtime = null;
    assert.deepEqual(observations, {submitted: 1, completed: 1, cleanup_confirmed: true});
    return {case: complete ? 'complete_public_result' : 'incomplete_public_result',
      native_turn_completed: true, public_answer_complete: returned.result.answer_complete,
      source_snapshot_exact: true, private_sentinel_not_published: true,
      raw_public_socket_absent_in_namespace: true, limited_proxy_present: true,
      original_tool_call_id_preserved: true, original_core_task_id_preserved: true,
      original_core_result_preserved: true, selected_providers_not_claimed_as_execution: true,
      public_submissions: observations.submitted, private_fixture_requests: privateRequests,
      approved_isolation_commands: approvals.length, session_and_public_cleanup_confirmed: true};
  } catch (error) {
    process.stderr.write(JSON.stringify({case: complete ? 'complete' : 'incomplete', stage, privateRequests,
      approvals: approvals.length, error: String((modelError ?? error).message).slice(0, 240)}) + '\n');
    throw error;
  } finally {
    clearTimeout(timer); if (runtime) await runtime.close().catch(() => {});
    for (const action of cleanups.reverse()) await action();
    await fs.rm(project, {recursive: true, force: false});
  }
}

async function main(args = process.argv.slice(2)) {
  if (!args.includes('--execute')) {
    process.stdout.write(JSON.stringify({execute: false, native_runtime: false, model_inference: false, peer_execution: false,
      usage: '--execute --node /absolute/node --build-report /absolute/build-report.json '
        + '[--report /same/build/directory/native-cooperative-smoke-replay.json]'}) + '\n'); return;
  }
  assert.ok([5, 7].includes(args.length)); assert.equal(args[0], '--execute');
  assert.equal(args[1], '--node'); assert.equal(args[3], '--build-report');
  const node = args[2], buildReport = args[4];
  for (const file of [node, buildReport]) {
    assert.equal(await fs.realpath(file), file); const info = await fs.stat(file);
    assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o6022, 0); assert.ok(info.isFile());
  }
  const report = JSON.parse(await fs.readFile(buildReport, 'utf8'));
  assert.equal(report.source_build, true); assert.equal(report.runtime_version, '1.18.34');
  if (args.length === 7) assert.equal(args[5], '--report');
  const output = args[6] ?? path.join(path.dirname(buildReport), 'native-cooperative-smoke-report.json');
  assert.equal(path.dirname(output), path.dirname(buildReport));
  assert.match(path.basename(output), /^native-cooperative-smoke[-a-z0-9]*\.json$/);
  try { await fs.access(output); throw Error('existing-cooperative-smoke-report'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = {version: 1, opencode: report.binary, opencodeSha256: report.binary_sha256,
    buildReport, node, nodeSha256: hash(await fs.readFile(node))};
  const complete = await scenario(config, true), incomplete = await scenario(config, false);
  const evidence = {version: 1, native_runtime: true, runtime_version: report.runtime_version,
    source_commit: report.source_commit, binary_sha256: report.binary_sha256, node_sha256: config.nodeSha256,
    model_inference: false, peer_execution: false, confidential_remote_execution: false,
    synthetic_private_model: true, synthetic_public_core: true, production_runtime_launcher: true,
    production_http_sse_client: true, production_chat_completions_provider: true,
    production_custom_tool: true, production_owner_proxy: true, production_public_delegation: true,
    cases: [complete, incomplete],
    scope: 'actual_native_cooperative_tool_chain_with_synthetic_cores_not_remote_models_or_peers'};
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write(JSON.stringify({...evidence, report: output}) + '\n');
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = {main};
