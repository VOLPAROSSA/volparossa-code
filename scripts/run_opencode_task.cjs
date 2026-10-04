// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Owner CLI: no execution on preview, no command or verifier chosen by the model.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const {OpenCodeRuntime, configuration} = require('../src/opencode-runtime.cjs');
const {createWorkspaceVerifier} = require('../src/workspace-verifier.cjs');
const {record} = require('../src/opencode-bridge.cjs');
const fail = () => Error('owner_task_configuration');
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
  fields.every(key => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= limit;

function validatePlan(value) {
  if (!exact(value, ['version', 'workspace', 'runtime', 'prompt', 'verification']) || value.version !== 1 ||
      !text(value.workspace, 4096) || !path.isAbsolute(value.workspace) ||
      !text(value.prompt, 65536) || !value.prompt.trim() ||
      !exact(value.verification, ['executable', 'args', 'timeoutMs', 'maxRounds'])) throw fail();
  const check = value.verification;
  if (!text(check.executable, 4096) || !path.isAbsolute(check.executable) || !Array.isArray(check.args) ||
      check.args.length > 128 || !check.args.every(arg => text(arg, 4096)) ||
      check.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 16384 ||
      !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 60000 ||
      !Number.isSafeInteger(check.maxRounds) || check.maxRounds < 1 || check.maxRounds > 16) throw fail();
  return Object.freeze({version: 1, workspace: value.workspace,
    runtime: Object.freeze(configuration(value.runtime, value.workspace)), prompt: value.prompt,
    verification: Object.freeze({...check, args: Object.freeze([...check.args])})});
}

function readPlan(file) {
  if (!text(file, 4096) || !path.isAbsolute(file)) throw fail();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600 || info.size > 131072) throw fail();
    const bytes = Buffer.alloc(info.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== info.size || !fs.fstatSync(fd).isFile()) throw fail();
    const plan = validatePlan(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, count))));
    const workspace = fs.realpathSync(plan.workspace), realFile = fs.realpathSync(file);
    // Configuration and prompt are captured outside the model-writable workspace.
    if (workspace !== plan.workspace || realFile.startsWith(workspace + '/') || realFile === workspace) throw fail();
    return plan;
  } catch { throw fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function preview(plan) {
  return {mode: 'preview', workspace: plan.workspace, execution: 'private_local',
    confidentialRemoteAvailable: false, deadlineMs: 2400000,
    verification: {...plan.verification}, toolApprovals: 'one-shot',
    semantics: 'Only the fixed selected check; not general task correctness.'};
}

async function executePlan(plan, {confirm, present = () => {}, signal,
  Runtime = OpenCodeRuntime, verifierFactory = createWorkspaceVerifier} = {}) {
  // The injectable seams exist for orchestration tests, not CLI command flags.
  plan = validatePlan(plan);
  if (typeof confirm !== 'function' || typeof present !== 'function') throw fail();
  if (signal?.aborted || await confirm({type: 'start', scope: preview(plan)}) !== true || signal?.aborted) {
    return {started: false, cleanupConfirmed: true};
  }
  const verify = verifierFactory({workspace: plan.workspace, executable: plan.verification.executable,
    args: plan.verification.args, timeoutMs: plan.verification.timeoutMs,
    approve: proposal => confirm(proposal)});
  let runtime, result;
  try {
    if (signal?.aborted) return {started: false, cleanupConfirmed: true};
    runtime = await Runtime.start(plan.runtime, {workspace: plan.workspace});
    result = await runtime.run(plan.prompt, {signal, verify, maxVerificationRounds: plan.verification.maxRounds,
      approve: proposal => confirm({type: 'native_tool', proposal}),
      onStatus: status => present({type: 'native_status', ...status})});
  } finally { if (runtime) await runtime.close(); }
  return {started: true, cleanupConfirmed: true, result};
}

async function main(argv) {
  if (argv.length !== 3 || !['--preview', '--execute'].includes(argv[0]) || argv[1] !== '--plan') throw fail();
  const plan = readPlan(argv[2]);
  if (argv[0] === '--preview') { process.stdout.write(JSON.stringify(preview(plan)) + '\n'); return 0; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('owner_task_tty_required');
  const terminal = readline.createInterface({input: process.stdin, output: process.stdout});
  const abort = new AbortController();
  const cancel = () => abort.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, cancel);
  terminal.once('SIGINT', cancel);
  const present = value => process.stdout.write(JSON.stringify(value) + '\n');
  const confirm = async proposal => {
    if (abort.signal.aborted) return false;
    // JSON escaping also prevents proposed commands/diffs becoming terminal controls.
    present(proposal);
    const word = proposal.type === 'start' ? 'START' : 'APPROVE ONCE';
    const decision = new AbortController();
    const cancelDecision = () => decision.abort();
    abort.signal.addEventListener('abort', cancelDecision, {once: true});
    const timer = setTimeout(cancelDecision, proposal.type === 'start' ? 60000 :
      Math.min(28000, proposal.type === 'workspace_verifier' ? proposal.timeoutMs : 28000));
    try { return await terminal.question(`Type ${word} to authorize, anything else declines: `,
      {signal: decision.signal}) === word; }
    catch { return false; }
    finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelDecision); }
  };
  try {
    const outcome = await executePlan(plan, {confirm, present, signal: abort.signal});
    present(outcome);
    if (!outcome.started) return 2;
    return outcome.result.verification?.status === 'passed' ? 0 : 2;
  } finally {
    abort.abort(); terminal.close();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, cancel);
  }
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; },
  () => { process.stderr.write('owner_task_failed_or_cleanup_unconfirmed\n'); process.exitCode = 1; });
module.exports = {validatePlan, readPlan, preview, executePlan, main};
