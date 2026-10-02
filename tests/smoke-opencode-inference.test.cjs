// SPDX-License-Identifier: GPL-3.0-only
// Pure scope contracts only: these tests never launch a model/runtime or VM.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {commandKind, approvalKind, ORIGINAL, TEST, retainFailure, closeRuntime,
  createTrialVerifier, runNativeTrial} = require('../scripts/smoke_opencode_inference.cjs');
const {emptyTaskDiagnostic} = require('../src/opencode-bridge.cjs');

async function trialProject(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trial-wiring-'));
  await fs.chmod(project, 0o700);
  t.after(() => fs.rm(project, {recursive: true, force: false}));
  await fs.writeFile(path.join(project, 'test_fixture.py'), TEST, {mode: 0o600, flag: 'wx'});
  return project;
}
test('ordinary scoped read and Python unittest spellings are accepted without a single expected command', () => {
  for (const cmd of ['cat fixture.py', 'cat /workspace/test_fixture.py', "sed -n '1,120p' fixture.py", 'ls -la', 'pwd']) {
    assert.equal(commandKind(cmd), 'read', cmd);
  }
  for (const cmd of ['python3 -m unittest', 'python3 -B -m unittest -v test_fixture.py',
    '/usr/bin/python3 -m unittest -q test_fixture', 'python -m unittest discover',
    'cd /workspace && python3 -m unittest test_fixture.py', 'cat fixture.py && python3 -m unittest']) {
    assert.equal(commandKind(cmd), 'test', cmd);
  }
});
test('network, arbitrary Python, destructive shell, traversal and alternate tests are refused', () => {
  for (const cmd of ['rm fixture.py', 'curl example.org', 'python3 -c "print(1)"', 'python3 fixture.py',
    'python3 -m unittest other.py', 'cat ../secret', 'cat /etc/passwd', 'cat fixture.py; ls',
    'cat fixture.py | cat', 'python3 -m unittest > receipt', 'cat $(pwd)', 'cat `pwd`',
    'cd /tmp && python3 -m unittest', 'cat fixture.py && rm fixture.py']) assert.equal(commandKind(cmd), null, cmd);
});
test('one-shot edit approval is limited to exact fixture, not tests or arbitrary metadata paths', () => {
  const proposal = {permission: 'edit', directory: '/workspace', patterns: ['fixture.py'], metadata: {filepath: '/workspace/fixture.py'}};
  assert.equal(approvalKind(proposal), 'edit');
  for (const changed of [{patterns: ['test_fixture.py']}, {patterns: ['fixture.py', 'README.txt']},
    {directory: '/tmp'}, {metadata: {filepath: '/etc/passwd'}}, {patterns: ['*.py']}]) {
    assert.equal(approvalKind({...proposal, ...changed}), null);
  }
});
test('fixture contains original bug and immutable behavioral tests, not a prewritten solution', () => {
  assert.equal(ORIGINAL, 'def add(a, b):\n    return a - b\n');
  assert.equal((TEST.match(/def test_/g) ?? []).length, 3);
  assert.match(TEST, /add\(2, 3\), 5/);
});
test('primary closed task failure survives a separate failed cleanup without disclosing error text', async () => {
  const evidence = {failure: null, cleanup_failure: null, runtime_cleanup_confirmed: false};
  retainFailure(evidence, Object.assign(Error('PRIVATE_CANARY'), {code: 'opencode_task_native_error',
    taskCleanupFailure: 'session_cleanup_unconfirmed'}));
  retainFailure(evidence, Error('later private error'));
  await closeRuntime(evidence, {async close() { throw Error('PRIVATE_CLEANUP_CANARY'); }});
  assert.equal(evidence.failure, 'opencode_task_native_error');
  assert.equal(evidence.cleanup_failure, 'runtime_cleanup_unconfirmed');
  assert.equal(evidence.task_cleanup_failure, 'session_cleanup_unconfirmed');
  assert.equal(evidence.runtime_cleanup_confirmed, false);
  assert.ok(!JSON.stringify(evidence).includes('CANARY'));
  const unknown = {failure: null, cleanup_failure: null, runtime_cleanup_confirmed: false};
  retainFailure(unknown, Error('a private path or model answer'));
  await closeRuntime(unknown, {async close() {}});
  assert.equal(unknown.failure, 'task_or_runtime_failed');
  assert.equal(unknown.cleanup_failure, null);
  assert.equal(unknown.runtime_cleanup_confirmed, true);
});
test('original trial receipt retains closed native tool facts without treating them as task success', async () => {
  const diagnostic = emptyTaskDiagnostic(); diagnostic.observed_calls = 1; diagnostic.tools.read.completed = 1;
  const evidence = {passed: false, failure: 'task_or_runtime_failed', cleanup_failure: null};
  await closeRuntime(evidence, {taskDiagnostics: diagnostic, async close() {}});
  assert.deepEqual(evidence.native_tool_diagnostics, diagnostic);
  assert.equal(evidence.runtime_cleanup_confirmed, true);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.failure, 'task_or_runtime_failed');
  const older = {};
  await closeRuntime(older, {async close() {}});
  assert.equal(older.native_tool_diagnostics, null); // Absent older counters are not zero observations.
});
test('trial selects original unittest argv and authorizes only currently intact owned test bytes', async t => {
  const project = await trialProject(t), file = path.join(project, 'test_fixture.py');
  let selected;
  const verifier = async () => ({status: 'failed', feedback: 'actual private test output'});
  assert.equal(createTrialVerifier(project, config => { selected = config; return verifier; }), verifier);
  const {approve, ...command} = selected;
  assert.deepEqual(command, {workspace: project, executable: '/usr/bin/python3',
    args: ['-B', '-m', 'unittest', '-v', 'test_fixture.py'], timeoutMs: 15000});
  assert.equal(await approve(), true);
  await fs.writeFile(file, TEST + '\n# changed\n');
  assert.equal(await approve(), false);
  await fs.writeFile(file, TEST);
  assert.equal(await approve(), true); // Re-read each check, not just a startup hash.
  await fs.chmod(file, 0o622);
  assert.equal(await approve(), false);
  await fs.chmod(file, 0o600);
  await fs.rename(file, path.join(project, 'original.py'));
  await fs.symlink('original.py', file);
  assert.equal(await approve(), false);
  await fs.unlink(file);
  assert.equal(await approve(), false);
});
test('trial wires owner feedback without changing prompt, signal, default round bound or native counters', async t => {
  const project = await trialProject(t), controller = new AbortController();
  const evidence = {approved_read: 0, approved_edit: 0, approved_test: 0, refused: 0,
    completed_commands: 0, failed_commands: 0, verification: null,
    passed: false, general_coding_quality_proven: false, model_answers_injected: false};
  const receipt = {status: 'failed', feedback: 'PRIVATE_CHECK_OUTPUT_CANARY'};
  const verify = async () => receipt;
  let calls = 0;
  await runNativeTrial({async run(prompt, options) {
    calls++;
    assert.equal(prompt, 'Read fixture.py and test_fixture.py. Fix the small bug in fixture.py, '
      + 'then run the existing Python unittest tests. Do not modify tests or install dependencies. '
      + 'This is an explicitly selected disposable project. Keep your final answer concise.');
    assert.deepEqual(Object.keys(options).sort(), ['approve', 'onStatus', 'signal', 'verify']);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.verify, verify);
    assert.equal(await options.verify({round: 1, remainingMs: 1000, signal: controller.signal}), receipt);
    assert.equal(evidence.approved_test, 0); // An owner check is not a model-issued test command.
    options.onStatus({commands: 2, status: 'failed'});
    return {nativeTurnCompleted: true, commands: 2, text: 'PRIVATE_MODEL_OUTPUT_CANARY',
      verification: {status: 'failed', checks: 3, continuations: 2}};
  }}, project, controller, evidence, verify);
  assert.equal(calls, 1); // Continuation belongs to the runtime, not a new trial/session.
  assert.deepEqual(evidence.verification, {status: 'failed', checks: 3, continuations: 2});
  assert.equal(evidence.failed_commands, 1);
  assert.equal(evidence.approved_read + evidence.approved_edit + evidence.approved_test, 0);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.general_coding_quality_proven, false);
  assert.equal(evidence.model_answers_injected, false);
  assert.ok(!JSON.stringify(evidence).includes('CANARY'));
});
test('native approval quota remains twelve and owner checks cannot manufacture edit or test approval', async t => {
  const project = await trialProject(t), controller = new AbortController();
  const evidence = {approved_read: 0, approved_edit: 0, approved_test: 0, refused: 0, verification: null};
  await assert.rejects(runNativeTrial({async run(_prompt, options) {
    const read = {permission: 'bash', directory: '/workspace', command: 'cat fixture.py'};
    for (let index = 0; index < 12; index++) assert.equal(await options.approve(read), true);
    assert.equal(await options.approve(read), false);
    assert.equal(controller.signal.aborted, true);
    throw Error('cancelled synthetic runtime');
  }}, project, controller, evidence, async () => ({status: 'passed', feedback: ''})), /cancelled synthetic runtime/);
  assert.equal(evidence.approved_read, 12);
  assert.equal(evidence.approved_edit, 0);
  assert.equal(evidence.approved_test, 0);
  assert.equal(evidence.refused, 1);
  assert.equal(evidence.verification, null);
});
test('unavailable verification remains terminal and cleanup failure cannot create a retained success', async t => {
  const project = await trialProject(t), controller = new AbortController();
  const evidence = {verification: null, passed: false};
  let calls = 0;
  await runNativeTrial({async run() {
    calls++;
    return {nativeTurnCompleted: true, commands: 0,
      verification: {status: 'unavailable', checks: 1, continuations: 0}};
  }}, project, controller, evidence, async () => ({status: 'unavailable', feedback: ''}));
  assert.equal(calls, 1);
  assert.deepEqual(evidence.verification, {status: 'unavailable', checks: 1, continuations: 0});
  const failed = {verification: null, passed: false};
  const cleanup = Object.assign(Error('PRIVATE_CLEANUP_CANARY'), {code: 'opencode_task_verification_cleanup_unconfirmed'});
  await assert.rejects(runNativeTrial({async run() { throw cleanup; }}, project, controller, failed,
    async () => ({status: 'failed', feedback: 'PRIVATE_CHECK_CANARY'})), error => error === cleanup);
  assert.deepEqual(failed, {verification: null, passed: false});
});
