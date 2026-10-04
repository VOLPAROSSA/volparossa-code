// SPDX-License-Identifier: GPL-3.0-only
// Disposable guest only: real external public core, no planner or model doubles.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {guestGuard} = require('./smoke_opencode_cooperation.cjs');
const {ORIGINAL, TEST, createTrialVerifier, isolatedCheck} = require('./smoke_opencode_inference.cjs');
const {createWorkspaceVerifier} = require('../src/workspace-verifier.cjs');
const {capturePublicCodeFile, applyPublicCodeFile} = require('../src/public-code-file.cjs');
const {CooperativeDelegation, createPublicCodeSnapshot} = require('../src/cooperative-delegation.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const QUESTION = 'Correct the bug in add: it should add its two numeric inputs. Return only the entire corrected Python file, '
  + 'without Markdown or explanation. Do not change tests or install dependencies.';
const CALL = 'owner-public-code-trial-1';
const PHASES = ['prepare', 'peer_execution', 'edit', 'owner_check', 'independent_check', 'complete'];
function options(args) {
  assert.deepEqual(args.filter((_, index) => index < 2 || index % 2 === 0),
    ['--execute', '--yes', '--public-socket', '--project-parent', '--output']);
  assert.equal(args.length, 8);
  const [, , , socketPath, , parent, , output] = args;
  for (const value of [socketPath, parent, output]) {
    assert(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
      && !value.includes('\0') && Buffer.byteLength(value) <= 4096);
  }
  return {socketPath, parent, output};
}
async function ownerDirectory(directory) {
  assert.equal(await fs.realpath(directory), directory);
  const info = await fs.lstat(directory);
  assert(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700);
}
function resultEvidence(response) {
  const value = response.result, output = value.outputs[0];
  // Called only after production transport validation of raw worker/source data.
  return {tool_call_id: response.tool_call_id, core_task_id: response.core_task_id,
    model_profile: value.model_profile, source_sha256: value.source_sha256, source_bytes: value.source_bytes,
    source_manifest_id: value.source_manifest_id, dataset_sha256: value.dataset_sha256,
    dataset_manifest_id: value.dataset_manifest_id, provider_key: value.provider_keys[0],
    model_fingerprint: value.model_fingerprint, peer_job_id: value.receipt.handle.binding.job_id,
    report_sha256: value.receipt.status.report_sha256, raw_result_sha256: sha(JSON.stringify(value)),
    output_sha256: sha(output.text), output_bytes: Buffer.byteLength(output.text),
    proposal_complete: value.proposal_complete, stop_reason: output.generation.stop_reason,
    generated_tokens: output.generated_tokens, core_reported_cleanup_confirmed: value.cleanup_confirmed};
}
async function executeTrial(input, evidence, controller) {
  let project, client, deadline;
  try {
    project = await fs.mkdtemp(path.join(input.parent, 'public-code-trial-')); await fs.chmod(project, 0o700);
    const sourceFile = path.join(project, 'fixture.py'), testFile = path.join(project, 'test_fixture.py');
    await fs.writeFile(sourceFile, ORIGINAL, {flag: 'wx', mode: 0o600});
    await fs.writeFile(testFile, TEST, {flag: 'wx', mode: 0o600});
    evidence.original_baseline_failed = await isolatedCheck(project, input.parent) === false;
    assert.equal(evidence.original_baseline_failed, true);
    const intactTests = async () => sha(await fs.readFile(testFile)) === sha(TEST);
    const source = capturePublicCodeFile({workspace: project, file: sourceFile});
    assert.equal(source.context, ORIGINAL);
    const snapshot = createPublicCodeSnapshot({question: QUESTION, context: source.context, license: 'GPL-3.0-only',
      public_content: true, rights_confirmed: true});
    // Fixed owner-selected verifier and authority exist before peer execution.
    const verify = createTrialVerifier(project, config => createWorkspaceVerifier({...config, approve: async value => {
      const allowed = await config.approve(value);
      if (allowed) evidence.owner_test_approved = true;
      return allowed;
    }}));
    deadline = setTimeout(() => controller.abort(), 2400000);
    client = new CooperativeDelegation(input.socketPath);
    evidence.phase = 'peer_execution';
    const caps = await client.connect();
    assert.equal(caps.code_proposal_v6, true); assert.equal(caps.model_profile, 'qwen3-0.6b-v1');
    const response = await client.execute({tool_call_id: CALL, snapshot, signal: controller.signal});
    evidence.public_result = resultEvidence(response);
    await client.close(); evidence.owner_cleanup_confirmed = true;
    evidence.phase = 'edit';
    const applied = await applyPublicCodeFile(source, snapshot, response, {signal: controller.signal,
      approve: async proposal => {
        const allowed = !controller.signal.aborted && proposal.file === sourceFile
          && proposal.sourceSha256 === sha(ORIGINAL) && proposal.coreTaskId === response.core_task_id
          && proposal.toolCallId === CALL && await intactTests();
        if (allowed) evidence.owner_edit_approved = true;
        return allowed;
      }});
    evidence.replacement_applied = applied.applied;
    assert.equal(applied.applied, true);
    evidence.phase = 'owner_check';
    const checked = await verify({round: 1, remainingMs: 15000, signal: controller.signal});
    evidence.owner_check_status = checked.status;
    evidence.phase = 'independent_check';
    evidence.original_tests_unchanged = await intactTests();
    evidence.fixture_changed = sha(await fs.readFile(sourceFile)) !== sha(ORIGINAL);
    evidence.only_selected_file_present = JSON.stringify((await fs.readdir(project)).sort())
      === JSON.stringify(['fixture.py', 'test_fixture.py']);
    evidence.independent_test_passed = evidence.original_tests_unchanged && await isolatedCheck(project, input.parent);
    assert(evidence.original_baseline_failed && evidence.original_tests_unchanged && evidence.fixture_changed && evidence.only_selected_file_present
      && evidence.independent_test_passed && evidence.owner_check_status === 'passed'
      && evidence.owner_edit_approved && evidence.owner_test_approved && !controller.signal.aborted);
    evidence.phase = 'complete';
  } catch {
    evidence.failure ??= controller.signal.aborted ? 'cancelled_or_deadline' : 'public_code_trial_failed';
  } finally {
    clearTimeout(deadline);
    if (client) {
      try { await client.close(); evidence.owner_cleanup_confirmed = true; }
      catch { evidence.cleanup_failure = 'core_cleanup_unconfirmed'; }
    }
    if (project) {
      try { await fs.rm(project, {recursive: true, force: false}); evidence.project_removed = true; }
      catch { evidence.cleanup_failure ??= 'project_cleanup_unconfirmed'; }
    }
  }
}
async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--preview') {
    process.stdout.write(JSON.stringify({execute: false, kind: 'public-code-single-file-trial-v1',
      synthetic_model_answers: false, usage: '--execute --yes --public-socket ABS --project-parent ABS --output NEW'}) + '\n');
    return;
  }
  const input = options(args); guestGuard();
  // Refuse an unsafe report scope before entering the failure-report path.
  await ownerDirectory(input.parent); await ownerDirectory(path.dirname(input.output));
  await assert.rejects(fs.lstat(input.output), {code: 'ENOENT'});
  const begin = Date.now(), controller = new AbortController(), cancel = () => controller.abort();
  const evidence = {version: 1, kind: 'public-code-single-file-trial-v1', passed: false, phase: 'prepare', failure: null,
    cleanup_failure: null, synthetic_model_answers: false, synthetic_public_core: false, local_planner_used: false,
    private_peer_execution_proven: false, full_coding_quality_proven: false, peer_datapath_proof_owned_by_parent: true,
    vm_cleanup_owned_by_parent: true, original_source_sha256: sha(ORIGINAL), original_tests_sha256: sha(TEST),
    question_sha256: sha(QUESTION), license: 'GPL-3.0-only', public_result: null,
    original_baseline_failed: false, owner_edit_approved: false, owner_test_approved: false,
    replacement_applied: false, owner_check_status: null,
    original_tests_unchanged: false, fixture_changed: false, only_selected_file_present: false,
    independent_test_passed: false, owner_cleanup_confirmed: false, project_removed: false, elapsed_ms: 0};
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, cancel);
  try { await executeTrial(input, evidence, controller); }
  finally { for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, cancel); }
  evidence.elapsed_ms = Date.now() - begin;
  evidence.passed = evidence.phase === 'complete' && evidence.failure === null && evidence.cleanup_failure === null
    && evidence.owner_cleanup_confirmed && evidence.project_removed;
  await fs.writeFile(input.output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write(JSON.stringify({passed: evidence.passed, phase: evidence.phase,
    failure: evidence.failure, cleanup_failure: evidence.cleanup_failure}) + '\n');
  if (!evidence.passed) process.exitCode = 1;
  return evidence;
}
if (require.main === module) main().catch(() => {
  process.stderr.write('{"passed":false,"phase":"guard","failure":"guard_or_input_rejected"}\n'); process.exitCode = 1;
});
module.exports = {main, options, resultEvidence, QUESTION, CALL, PHASES};
