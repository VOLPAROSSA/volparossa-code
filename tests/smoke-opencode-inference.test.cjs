// SPDX-License-Identifier: GPL-3.0-only
// Pure scope contracts only: these tests never launch a model/runtime or VM.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {commandKind, approvalKind, ORIGINAL, TEST, retainFailure, closeRuntime} = require('../scripts/smoke_opencode_inference.cjs');
const {emptyTaskDiagnostic} = require('../src/opencode-bridge.cjs');
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
