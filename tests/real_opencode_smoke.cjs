// SPDX-License-Identifier: GPL-3.0-only
// Explicit native OpenCode / production launcher smoke with SYNTHETIC core output.
// This proves runtime, HTTP/SSE, approval, tool-result correlation and a disposable
// file mutation, NOT model inference, intelligence or confidential peer execution.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {OpenCodeRuntime} = require('../src/opencode-runtime.cjs');
const {caps, result, reply, fixture} = require('./conversation-fixture.cjs');

const MODEL = 'qwen3-0.6b-v1';
const CALL = 'volparossa-native-smoke-tool';
const COMMAND = "printf 'native-opencode-smoke\\n' > smoke.txt";
const FINAL = 'Synthetic native tool loop completed; no model inference claim.';
const hash = value => createHash('sha256').update(value).digest('hex');

async function main(args = process.argv.slice(2)) {
  if (!args.includes('--execute')) {
    process.stdout.write(JSON.stringify({execute: false, native_runtime: false, model_inference: false,
      peer_execution: false, usage: '--execute --node /absolute/node --build-report /absolute/build-report.json '
        + '[--report /same/build/directory/native-smoke-replay.json]'}) + '\n');
    return;
  }
  assert.ok([5, 7].includes(args.length), 'explicit bounded arguments required');
  assert.equal(args[0], '--execute'); assert.equal(args[1], '--node'); assert.equal(args[3], '--build-report');
  const node = args[2], buildReport = args[4];
  for (const file of [node, buildReport]) {
    assert.equal(await fs.realpath(file), file, 'canonical paths required');
    const info = await fs.stat(file);
    assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o6022, 0); assert.ok(info.isFile());
  }
  const report = JSON.parse(await fs.readFile(buildReport, 'utf8'));
  assert.equal(report.source_build, true); assert.equal(report.runtime_version, '1.18.34');
  if (args.length === 7) assert.equal(args[5], '--report');
  const output = args[6] ?? path.join(path.dirname(buildReport), 'native-smoke-report.json');
  assert.equal(path.dirname(output), path.dirname(buildReport), 'report remains in the selected build directory');
  assert.match(path.basename(output), /^native-smoke[-a-z0-9]*\.json$/);
  try { await fs.access(output); throw Error('existing-native-smoke-report'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'volparossa-opencode-native-'));
  await fs.chmod(project, 0o700);
  await fs.writeFile(path.join(project, 'README.txt'), 'Disposable, entirely synthetic OpenCode smoke project.\n', {mode: 0o600});
  const cleanups = [], proposals = [], statuses = [];
  let runtime, fixtureError, completed, cleanup = false, submissions = 0, toolProposed = false, followup = false;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 90000);
  try {
    const core = await fixture({after: action => cleanups.push(action)}, (socket, message) => {
      try {
        assert.equal(message.operation.type, 'submit_conversation');
        const conversation = message.operation.conversation;
        assert.equal(conversation.visibility, 'private_local');
        assert.ok(++submissions <= 16, 'bounded fixture requests');
        let value;
        if (conversation.tools.some(tool => tool.name === 'bash')) {
          const returned = conversation.history.find(item => item.type === 'tool_result' && item.call_id === CALL);
          if (!toolProposed) {
            assert.equal(returned, undefined); toolProposed = true;
            value = {type: 'function_call', call_id: CALL, namespace: null, name: 'bash', arguments: {
              command: COMMAND, description: 'Write one explicitly authorized synthetic smoke file.', timeout: 10000,
            }};
          } else {
            assert.ok(returned, 'the actual upstream tool result must return to the core');
            const call = conversation.history.find(item => item.type === 'function_call' && item.call_id === CALL);
            assert.equal(call?.name, 'bash'); assert.equal(call.arguments.command, COMMAND);
            followup = true; value = {type: 'assistant', text: FINAL};
          }
        } else {
          // Upstream may ask the small model for a title. This remains explicit
          // synthetic output and is not mistaken for the coding turn/tool result.
          value = {type: 'assistant', text: 'Synthetic native smoke'};
        }
        reply(socket, message, 'admitted');
        reply(socket, message, 'result', {result: result(value, MODEL)});
      } catch (error) {
        fixtureError = error; socket.destroy(); abort.abort();
      }
    }, caps(MODEL));
    const config = {version: 1, opencode: report.binary, opencodeSha256: report.binary_sha256,
      buildReport, node, nodeSha256: hash(await fs.readFile(node)), socketPath: core.socketPath};
    runtime = await OpenCodeRuntime.start(config, {workspace: project});
    assert.equal(runtime.execution, 'private_local'); assert.equal(runtime.confidentialRemoteAvailable, false);
    completed = await runtime.run('Create smoke.txt containing native-opencode-smoke followed by a newline. '
      + 'Use the bash tool once; this is an explicitly authorized disposable synthetic test.', {
      signal: abort.signal,
      approve: async proposal => {
        proposals.push(proposal);
        return proposal.permission === 'bash' && proposal.command === COMMAND && proposal.directory === '/workspace';
      },
      onStatus: status => statuses.push(status),
    });
    if (fixtureError) throw fixtureError;
    assert.equal(completed.nativeTurnCompleted, true); assert.equal(completed.taskVerified, false);
    assert.equal(completed.text, FINAL); assert.equal(completed.commands, 1);
    assert.equal(proposals.length, 1); assert.equal(proposals[0].command, COMMAND);
    assert.ok(statuses.some(status => status.commands === 1 && status.status === 'completed'));
    assert.equal(toolProposed, true); assert.equal(followup, true);
    assert.equal(await fs.readFile(path.join(project, 'smoke.txt'), 'utf8'), 'native-opencode-smoke\n');
    await runtime.close(); runtime = null; cleanup = true;
    const evidence = {version: 1, native_runtime: true, runtime_version: report.runtime_version,
      source_commit: report.source_commit, binary_sha256: report.binary_sha256,
      node_sha256: config.nodeSha256, model_inference: false, peer_execution: false,
      confidential_remote_execution: false, synthetic_private_conversation_core: true,
      production_runtime_launcher: true, production_http_sse_client: true,
      production_chat_completions_provider: true, namespace_network_only: true,
      owner_credentials_mounted: false, observed_execution: 'private_local',
      approvals: proposals.length, completed_commands: completed.commands, tool_result_correlated: followup,
      actual_file_change_verified: true, inference_requests: submissions, session_cleanup_confirmed: cleanup,
      scope: 'actual_native_runtime_with_synthetic_core_not_real_model_or_peer_execution'};
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    process.stdout.write(JSON.stringify({...evidence, report: output}) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({native_runtime: false, model_inference: false, peer_execution: false,
      submissions, tool_proposed: toolProposed, tool_followup: followup, approvals: proposals.length,
      session_cleanup_confirmed: cleanup, error: String(error.message).slice(0, 200)}) + '\n');
    throw error;
  } finally {
    clearTimeout(deadline);
    if (runtime) await runtime.close().catch(() => {});
    for (const action of cleanups.reverse()) await action();
    // Only this exact mkdtemp project is removed; it never contains owner data.
    await fs.rm(project, {recursive: true, force: false});
  }
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = {main};
