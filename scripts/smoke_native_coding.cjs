// SPDX-License-Identifier: GPL-3.0-only
// Actual pinned app-server + actual core conversation. No synthetic model reply.
'use strict';
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {AppServer} = require('/opt/src/app-server.cjs');
const {PrivateConversation} = require('/opt/src/private-conversation.cjs');
const {startResponsesProvider} = require('/opt/src/responses-provider.cjs');
const {MODEL, PROJECT, modelCatalog, runtimeSettings, APPROVAL_DENIALS,
  ITEM_TYPES, NativeTaskController} = require('/opt/src/native-coding-fixture.cjs');
const sha = data => createHash('sha256').update(data).digest('hex');

async function main() {
  assert.equal(process.cwd(), PROJECT);
  assert.notEqual(process.getuid(), 0);
  for (const key of ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) assert.equal(process.env[key], undefined);
  const original = fs.readFileSync(`${PROJECT}/arithmetic.py`);
  const instructions = fs.readFileSync('/opt/upstream-prompt.md', 'utf8');
  const report = {version: 3, kind: 'native-codex-core-coding', success: false, phase: 'capabilities',
    model: MODEL, full_native_prompt_sha256: sha(instructions), before_sha256: sha(original), after_sha256: null,
    native_turn_completed: false, read: false, edit: false, test: false, independent_test_passed: false,
    accepted_commands: 0, declined_commands: 0,
    approval_denials: Object.fromEntries(APPROVAL_DENIALS.map(reason => [reason, 0])),
    turns_started: 0, turns_completed: 0,
    item_types: Object.fromEntries(ITEM_TYPES.map(type => [type, 0])), response_diagnostics: null,
    unexpected_command: false, thread_unsubscribed: false,
    responses: null, private_peer_execution_claimed: false, general_coding_quality_claimed: false,
    runtime_exit: null, forced_stop: false, diagnostic: null};
  let provider, child, client, exited, threadId, controller;
  let stderrBytes = 0;
  let deadline;
  async function stop() {
    if (controller) await controller.stop();
    else client?.close();
  }
  try {
    const preflight = new PrivateConversation('/opt/core/compute.sock');
    try {
      const caps = await preflight.connect();
      assert.equal(caps.model_profile, MODEL);
      assert.equal(caps.native_tool_template, true);
      assert.equal(caps.local_only, true);
    } finally { preflight.close(); }
    fs.writeFileSync('/opt/catalog.json', JSON.stringify(modelCatalog(instructions)), {flag: 'wx', mode: 0o444});
    provider = await startResponsesProvider({socketPath: '/opt/core/compute.sock', model: MODEL, diagnostics: true});
    report.phase = 'launch';
    child = spawn('/opt/codex-app-server', ['--listen', 'stdio://', '--strict-config',
      ...runtimeSettings(provider.baseUrl).flatMap(value => ['-c', value])], {
      stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, VOLPAROSSA_PROVIDER_TOKEN: provider.bearerToken}});
    exited = new Promise(resolve => {
      child.once('error', () => { controller?.closed(); resolve({code: null, signal: 'spawn_failed'}); });
      child.once('close', (code, signal) => { controller?.closed(); resolve({code, signal}); });
    });
    child.stderr.on('data', data => {
      stderrBytes += data.length;
      if (stderrBytes > 1024 * 1024) { report.diagnostic = 'stderr_bound'; void stop(); }
    }); // Never store stderr, bearer tokens, model prompts, tool arguments or raw output.
    client = new AppServer(child.stdout, child.stdin, {timeoutMs: 30000, allowedModels: [MODEL], writableRoot: PROJECT,
      commandApproval(params) {
        if (controller) return controller.approve(params);
        report.declined_commands++; report.approval_denials.lineage++;
        if (report.declined_commands > 2) void stop();
        return false;
      }});
    report.phase = 'initialize'; await client.initialize();
    report.phase = 'thread-start';
    const started = await client.startThread({model: MODEL, cwd: PROJECT});
    assert.equal(started.model, MODEL); assert.equal(started.thread.modelProvider, 'volparossa');
    assert.equal(started.thread.ephemeral, true); assert.equal(started.cwd, PROJECT);
    threadId = started.thread.id;
    controller = new NativeTaskController(client, threadId, report);
    report.phase = 'native-turn';
    deadline = setTimeout(() => { report.diagnostic = 'turn_deadline'; void stop(); }, 2400000);
    await controller.run();
    assert(report.read && report.edit && report.test && !report.unexpected_command);
    report.phase = 'independent-check';
    const checked = spawnSync('/usr/bin/python3', ['-B', '/opt/fixture.py', 'test'], {
      cwd: PROJECT, encoding: 'utf8', maxBuffer: 8192, timeout: 5000});
    assert.equal(checked.status, 0);
    assert.deepEqual(JSON.parse(checked.stdout), {action: 'test', passed: true, tests: 3});
    report.independent_test_passed = true;
    report.after_sha256 = sha(fs.readFileSync(`${PROJECT}/arithmetic.py`));
    assert.notEqual(report.after_sha256, report.before_sha256);
    assert.deepEqual(fs.readdirSync(PROJECT).sort(), ['arithmetic.py']);
    report.responses = provider.observations;
    assert(report.responses.completed >= 4 && report.responses.incomplete === 0 &&
      report.responses.submitted === report.responses.cleanup_confirmed);
    report.phase = 'unsubscribe';
    assert.equal((await client.request('thread/unsubscribe', {threadId})).status, 'unsubscribed');
    report.thread_unsubscribed = true;
  } catch {
    report.diagnostic ??= 'native_coding_incomplete';
  } finally {
    clearTimeout(deadline);
    if (!report.native_turn_completed) await stop();
    controller?.dispose();
    client?.close();
    if (provider) {
      try { await provider.close(); }
      catch { report.diagnostic = 'provider_cleanup_unconfirmed'; }
      report.responses = provider.observations;
      report.response_diagnostics = provider.diagnostics;
    }
    if (child) {
      let timer;
      let exit = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); })]);
      clearTimeout(timer);
      if (!exit) {
        report.forced_stop = true; child.kill('SIGTERM');
        const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
        exit = await exited; clearTimeout(hard);
      }
      report.runtime_exit = exit.code;
    }
    report.success = report.native_turn_completed && report.read && report.edit && report.test &&
      report.independent_test_passed && report.thread_unsubscribed && !report.unexpected_command &&
      !report.diagnostic && !report.forced_stop && report.runtime_exit === 0;
    if (report.success) report.phase = 'complete';
    fs.writeFileSync('/opt/work/receipt.json', JSON.stringify(report) + '\n', {flag: 'wx', mode: 0o600});
    if (!report.success) process.exitCode = 1;
  }
}
main().catch(() => { process.exitCode = 1; });
