// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Synthetic orchestration only. The separate bwrap smoke exercises isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {validatePlan, readPlan, preview, executePlan} = require('../scripts/run_opencode_task.cjs');
function plan(workspace = '/fixture/workspace') {
  return {version: 1, workspace, prompt: 'Private original task',
    runtime: {version: 1, opencode: '/fixture/opencode', opencodeSha256: 'a'.repeat(64),
      buildReport: '/fixture/report.json', node: '/fixture/node', nodeSha256: 'b'.repeat(64), socketPath: '/fixture/core.sock'},
    verification: {executable: '/usr/bin/python3', args: ['-B', '-m', 'unittest'], timeoutMs: 1000, maxRounds: 2}};
}
test('owner plan is exact, immutable and preview omits the private prompt without executing', () => {
  const original = plan(), captured = validatePlan(original);
  original.verification.args[0] = 'CHANGED'; original.runtime.node = '/CHANGED';
  assert.equal(captured.verification.args[0], '-B'); assert.equal(captured.runtime.node, '/fixture/node');
  const value = preview(captured);
  assert.equal(value.deadlineMs, 2400000); assert.equal(value.confidentialRemoteAvailable, false);
  assert.equal(value.verification.maxRounds, 2); assert.ok(!JSON.stringify(value).includes('Private original task'));
  for (const invalid of [{...plan(), verifierFromModel: true}, {...plan(), version: 2},
    {...plan(), verification: {...plan().verification, maxRounds: 0}},
    {...plan(), verification: {...plan().verification, args: 'shell text'}},
    {...plan(), verification: {...plan().verification, timeoutMs: 60001}}]) {
    assert.throws(() => validatePlan(invalid), /owner_task/);
  }
});
test('file plan must be owner-private, regular and outside the selected canonical workspace', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-owner-plan-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = path.join(root, 'workspace'), file = path.join(root, 'owner.json');
  fs.mkdirSync(workspace, {mode: 0o700});
  fs.writeFileSync(file, JSON.stringify(plan(workspace)), {mode: 0o600});
  assert.equal(readPlan(file).workspace, workspace);
  fs.chmodSync(file, 0o644); assert.throws(() => readPlan(file), /owner_task/); fs.chmodSync(file, 0o600);
  const link = path.join(root, 'link.json'); fs.symlinkSync(file, link);
  assert.throws(() => readPlan(link), /owner_task/);
  const modelFile = path.join(workspace, 'owner.json');
  fs.writeFileSync(modelFile, JSON.stringify(plan(workspace)), {mode: 0o600});
  assert.throws(() => readPlan(modelFile), /owner_task/);
});
test('declining startup starts neither verifier nor native runtime', async () => {
  const outcome = await executePlan(plan(), {confirm: async proposal => {
    assert.equal(proposal.type, 'start'); return false;
  }, Runtime: {start() { assert.fail('no startup'); }}, verifierFactory() { assert.fail('no verifier'); }});
  assert.deepEqual(outcome, {started: false, cleanupConfirmed: true});
});
test('CLI snapshots the fixed check before native startup and joins cleanup before reporting selected success', async () => {
  const events = [], source = plan(), proposals = [];
  const outcome = await executePlan(source, {
    confirm: async proposal => { proposals.push(proposal); return true; },
    verifierFactory(settings) {
      events.push('verifier-selected'); assert.equal(settings.workspace, source.workspace);
      assert.deepEqual(settings.args, ['-B', '-m', 'unittest']);
      return async ({round}) => {
        assert.equal(await settings.approve({type: 'workspace_verifier', ...settings, round}), true);
        return {status: 'passed', feedback: ''};
      };
    },
    Runtime: {async start(runtimeConfig, {workspace}) {
      events.push('start'); assert.equal(workspace, source.workspace); assert.deepEqual(runtimeConfig, source.runtime);
      source.verification.executable = '/MODEL_CANNOT_CHANGE_CAPTURED_COMMAND';
      return {async run(prompt, options) {
        assert.equal(prompt, source.prompt); assert.equal(options.maxVerificationRounds, 2);
        assert.equal(await options.approve({permission: 'edit', command: 'selected edit'}), true);
        assert.equal((await options.verify({round: 1, remainingMs: 500, signal: new AbortController().signal})).status, 'passed');
        events.push('run'); return {taskVerified: false, verification: {status: 'passed', checks: 1, continuations: 0}};
      }, async close() { events.push('close'); }};
    }},
  });
  assert.deepEqual(events, ['verifier-selected', 'start', 'run', 'close']);
  assert.deepEqual(proposals.map(proposal => proposal.type), ['start', 'native_tool', 'workspace_verifier']);
  assert.equal(outcome.cleanupConfirmed, true); assert.equal(outcome.result.taskVerified, false);
});
test('CLI failure and cleanup uncertainty never become selected-check success', async () => {
  for (const failClose of [false, true]) {
    let closed = 0;
    await assert.rejects(executePlan(plan(), {confirm: async () => true, verifierFactory: () => async () => {},
      Runtime: {async start() { return {
        async run() { if (!failClose) throw Error('task_incomplete'); return {verification: {status: 'passed'}}; },
        async close() { closed++; if (failClose) throw Error('cleanup_unconfirmed'); },
      }; }},
    }), failClose ? /cleanup_unconfirmed/ : /task_incomplete/);
    assert.equal(closed, 1);
  }
});
