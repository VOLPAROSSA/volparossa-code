// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Inert contract tests only: no model, peer or disposable guest is started here.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {options, resultEvidence, QUESTION, CALL, PHASES} = require('../scripts/smoke_public_code_proposal.cjs');
const {ORIGINAL, TEST} = require('../scripts/smoke_opencode_inference.cjs');
const {result} = require('./public-code-fixture.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const argv = ['--execute', '--yes', '--public-socket', '/tmp/socket', '--project-parent', '/tmp/project', '--output', '/tmp/report'];

test('new real-peer driver is inert on preview and accepts only explicit fixed guest inputs', () => {
  assert.deepEqual(options(argv), {socketPath: '/tmp/socket', parent: '/tmp/project', output: '/tmp/report'});
  for (const args of [argv.slice(1), [...argv, '--model', 'other'], argv.map(v => v === '/tmp/project' ? '../project' : v),
    argv.map(v => v === '--yes' ? '--force' : v), argv.map(v => v === '/tmp/socket' ? '/tmp/../socket' : v)]) {
    assert.throws(() => options(args));
  }
  const preview = spawnSync(process.execPath, [path.join(__dirname, '../scripts/smoke_public_code_proposal.cjs'), '--preview'],
    {encoding: 'utf8', timeout: 5000});
  assert.equal(preview.status, 0);
  assert.deepEqual(JSON.parse(preview.stdout), {execute: false, kind: 'public-code-single-file-trial-v1',
    synthetic_model_answers: false, usage: '--execute --yes --public-socket ABS --project-parent ABS --output NEW'});
});
test('fixture and original positive/negative/zero tests remain unchanged; request supplies no replacement', () => {
  assert.equal(ORIGINAL, 'def add(a, b):\n    return a - b\n');
  assert.equal(TEST, 'import unittest\nfrom fixture import add\n\nclass AddTests(unittest.TestCase):\n'
    + '    def test_positive(self):\n        self.assertEqual(add(2, 3), 5)\n'
    + '    def test_negative(self):\n        self.assertEqual(add(-4, 1), -3)\n'
    + '    def test_zero(self):\n        self.assertEqual(add(0, 7), 7)\n');
  assert(Buffer.byteLength(ORIGINAL) <= 4096 && Buffer.byteLength(QUESTION) <= 512);
  assert(!QUESTION.includes('a + b') && !QUESTION.includes('return a'));
  assert.equal(CALL, 'owner-public-code-trial-1');
  assert.deepEqual(PHASES, ['prepare', 'peer_execution', 'edit', 'owner_check', 'independent_check', 'complete']);
});
test('closed trial evidence binds exact raw result and worker output without leaking either', () => {
  const value = result(), response = {result: value, tool_call_id: CALL, core_task_id: 'code-7'};
  const evidence = resultEvidence(response);
  assert.equal(evidence.raw_result_sha256, sha(JSON.stringify(value)));
  assert.equal(evidence.report_sha256, value.receipt.status.report_sha256);
  assert.equal(evidence.output_sha256, sha(value.outputs[0].text));
  assert.equal(evidence.output_bytes, Buffer.byteLength(value.outputs[0].text));
  assert.equal(evidence.model_profile, value.model_profile);
  assert.equal(evidence.peer_job_id, value.receipt.handle.binding.job_id);
  assert.equal(evidence.stop_reason, 'eos');
  assert(!JSON.stringify(evidence).includes(value.outputs[0].text));
  value.outputs[0].text += '\n';
  assert.notEqual(resultEvidence(response).raw_result_sha256, evidence.raw_result_sha256);
  assert.notEqual(resultEvidence(response).output_sha256, evidence.output_sha256);
});
