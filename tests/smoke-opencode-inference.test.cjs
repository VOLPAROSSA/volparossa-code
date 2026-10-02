// SPDX-License-Identifier: GPL-3.0-only
// Pure scope contracts only: these tests never launch a model/runtime or VM.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {commandKind, approvalKind, ORIGINAL, TEST} = require('../scripts/smoke_opencode_inference.cjs');
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
