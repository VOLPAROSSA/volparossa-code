// SPDX-License-Identifier: GPL-3.0-only
// Owner-side actions on rendered VSCodium controls. The private model chooses every tool call.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {button, decision, invokeCommand} = require('./opencode_editor_ui.cjs');
const LABEL = 'VOLPAROSSA: Run OpenCode Task with Enrolled Public Source';
const TASK = 'Use the enrolled public source task to ask the peer for a fix. Inspect its original complete replacement. '
  + 'Read fixture.py, apply that exact replacement using edit after approval, and leave the tests intact. '
  + 'The owner will verify the result. Do not send anything else to peers.';

async function settings(owner) {
  const endpoint = owner + '/private.sock';
  const info = await fs.lstat(endpoint);
  assert.ok(info.isSocket() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600);
  const report = '/opt/volparossa-runtime/build-report.json';
  const build = JSON.parse(await fs.readFile(report, 'utf8'));
  return {'volparossaCode.privateSocket':endpoint, 'volparossaCode.openCodeRuntime':{
    version:1, opencode:'/opt/volparossa-runtime/opencode', opencodeSha256:build.binary_sha256,
    buildReport:report, node:'/opt/volparossa-node', nodeSha256:'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12'}};
}

async function exercise(cdp, evidence, intactTests, {wait, QUESTION, PROJECT, CHECK}) {
  await invokeCommand(cdp, LABEL);
  async function enter(title, value) {
    const ui = await wait(cdp, view => view.quick && view.title === title, 30, 'public_task');
    await cdp.click(ui.quick);
    await cdp.call('Input.insertText', {text:value});
    await cdp.key('Enter', 'Enter', 13);
  }
  await enter('Enroll a public cooperative task', QUESTION);
  let ui = await wait(cdp, view => view.license && view.title.startsWith('Select the license'), 15, 'license');
  await cdp.click(ui.license);
  ui = await wait(cdp, view => view.dialogs.length === 1 && view.plannerPreview, 30, 'publication_preview');
  const consent = ui.dialogs[0];
  assert.ok(consent.message.includes('Confirm this exact question and complete saved source file are public')
    && consent.message.includes('only local one-shot approvals permit edits and commands'), 'publication_scope');
  evidence.previewed_exact_public_source = true;
  await button(cdp,consent,'Enroll public snapshot');
  evidence.owner_enrolled_public_source = true;
  await enter('VOLPAROSSA OpenCode task', TASK);
  ui = await wait(cdp, view => view.dialogs.length === 1, 30, 'planner_start');
  const start = ui.dialogs[0];
  assert.ok(start.message.startsWith('Allow an OpenCode coding task in ' + PROJECT + '?')
    && start.message.includes('The model may invoke it once')
    && start.message.includes('Owner-selected check: ' + JSON.stringify(CHECK)), 'planner_start');
  await button(cdp, start, 'Start coding with public delegation');
  evidence.local_planner_started = true;
  let previous = start.message;
  const deadline = Date.now() + 2400000;
  while (Date.now() < deadline) {
    ui = await wait(cdp, () => true, 3, 'peer_operation');
    assert.ok(!ui.failed && ui.dialogs.length <= 1, 'peer_operation');
    if (ui.applied) {
      assert.ok(ui.plannerModel && ui.submitted && ui.complete && ui.plannerCheck && ui.output && ui.core && ui.job && ui.peer
        && evidence.owner_edit_approved && evidence.owner_test_approved, 'planner_result');
      Object.assign(evidence, {model_requested_delegation:true, local_model_profile:'qwen3-0.6b-v1', result_shown:true,
        owner_check_status:'passed', core_task_id:ui.core, peer_job_id:ui.job, report_sha256:ui.peer, replacement_sha256:ui.output});
      return;
    }
    const dialog = ui.dialogs[0];
    if (dialog && dialog.message !== previous) {
      const count = evidence.approved_edits + evidence.approved_commands + evidence.approved_checks;
      const kind = decision(dialog.message, PROJECT, count);
      if (!kind || !await intactTests() || (kind === 'edit' && !ui.editPreview)) {
        await button(cdp, dialog, 'Cancel');
        throw Error('planner_action');
      }
      await button(cdp, dialog, kind === 'check' ? 'Run check once' : 'Approve once');
      if (kind === 'check') { evidence.approved_checks++; evidence.owner_test_approved = true; }
      else if (kind === 'edit') { evidence.approved_edits++; evidence.owner_edit_approved = true; }
      else evidence.approved_commands++;
    }
    previous = dialog?.message ?? null;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw Error('peer_deadline');
}
module.exports = {exercise, settings};
if (require.main === module) require('./public_peer_editor_ui.cjs').run(module.exports).catch(() => {process.exitCode=1;});
