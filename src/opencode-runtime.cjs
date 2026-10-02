// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {readFrames, writeFrame, record, isFailureCode, validProviderDiagnostic} = require('./opencode-bridge.cjs');
const FIELDS = ['version', 'opencode', 'opencodeSha256', 'buildReport', 'node', 'nodeSha256', 'socketPath'];
const fail = (code = 'runtime_failed') => Object.assign(Error('opencode_runtime_unavailable_or_cleanup_unconfirmed'), {code});
function configuration(value, workspace) {
  if (!record(value) || value.version !== 1 || Object.keys(value).length !== FIELDS.length ||
      !FIELDS.every(key => Object.hasOwn(value, key))) throw fail();
  for (const key of FIELDS.slice(1)) {
    const item = value[key];
    if (typeof item !== 'string' || !item || item.includes('\0') || Buffer.byteLength(item) > 4096 ||
        (key.endsWith('Sha256') ? !/^[a-f0-9]{64}$/.test(item) : !path.isAbsolute(item))) throw fail();
  }
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0') ||
      Buffer.byteLength(workspace) > 4096) throw fail();
  return {...value};
}
async function ownedOpenCode(child, {startupMs = 30000, closeMs = 45000, killMs = 5000, cancelMs = 45000} = {}) {
  if (![startupMs, closeMs, killMs, cancelMs].every(value => Number.isInteger(value) && value > 0 && value <= 60000) ||
      cancelMs > 45000) throw fail();
  let terminal, run, used = false, closing, settled = false, readyResolve, readyReject, protocolBad = false;
  let diagnostics = null;
  function complete(error, result) {
    if (!run || run.finished) return;
    run.finished = true; clearTimeout(run.cancelTimer);
    if (error) run.reject(error); else run.resolve(result);
  }
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => {
    const done = (code, signal) => {
      terminal ??= {code, signal}; resolve(terminal); readyReject(fail()); complete(fail());
    };
    child.once('error', () => done(null, 'spawn_failed')); child.once('close', done);
  });
  function bad() { protocolBad = true; readyReject(fail()); complete(fail()); child.stdin.end(); }
  const unbind = readFrames(child.stdout, value => {
    if (protocolBad) return;
    if (!settled) {
      if (value.type !== 'ready' || value.version !== 1 || value.execution !== 'private_local' ||
          value.confidentialRemoteAvailable !== false) { bad(); return; }
      settled = true; readyResolve(); return;
    }
    if (!run || run.finished) { bad(); return; }
    if (['result', 'failed'].includes(value.type) && value.diagnostics !== undefined) {
      if (!validProviderDiagnostic(value.diagnostics)) { bad(); return; }
      diagnostics = value.diagnostics;
    }
    if (value.type === 'approval') {
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || value.id <= run.lastApproval ||
          !record(value.proposal) || !['bash', 'edit'].includes(value.proposal.permission)) { bad(); return; }
      run.lastApproval = value.id;
      const active = run;
      Promise.resolve().then(() => active.approve(value.proposal)).then(accepted => {
        if (active === run && !active.stopped && !active.finished && !protocolBad && !terminal) {
          writeFrame(child.stdin, {type: 'approval', id: value.id, accepted: accepted === true});
        }
      }).catch(() => {
        if (active === run && !active.stopped && !active.finished && !protocolBad && !terminal) {
          try { writeFrame(child.stdin, {type: 'approval', id: value.id, accepted: false}); } catch { bad(); }
        }
      });
    } else if (value.type === 'status') {
      if (!Number.isSafeInteger(value.commands) || value.commands < run.lastCommands || value.commands > 1024 ||
          !['completed', 'failed'].includes(value.status)) { bad(); return; }
      run.lastCommands = value.commands;
      run.onStatus({commands: value.commands, status: value.status});
    } else if (value.type === 'result') {
      const result = value.result;
      if (!record(result) || result.nativeTurnCompleted !== true || result.taskVerified !== false ||
          typeof result.text !== 'string' || Buffer.byteLength(result.text) > 65536 ||
          !Number.isSafeInteger(result.commands) || result.commands < run.lastCommands || result.commands > 1024 || run.stopped) { bad(); return; }
      complete(null, result);
    } else if (value.type === 'failed') {
      if (value.reason !== undefined && !isFailureCode(value.reason)) { bad(); return; }
      if (value.task_cleanup_failure != null && value.task_cleanup_failure !== 'session_cleanup_unconfirmed') { bad(); return; }
      const error = fail(value.reason);
      if (value.task_cleanup_failure) error.taskCleanupFailure = value.task_cleanup_failure;
      complete(error);
    }
    else bad();
  }, bad);
  child.stdin.on('error', bad);
  const outputEnded = () => {
    if (!closing && (!settled || run && !run.finished)) bad();
  };
  child.stdout.on('end', outputEnded); child.stdout.on('close', outputEnded);
  // Raw runtime output is never returned as an editor error or persisted.
  let stderr = 0;
  child.stderr.on('data', data => { stderr += data.length; if (stderr > 1048576) bad(); });
  child.stderr.on('error', bad);
  async function close() {
    closing ??= (async () => {
      child.stdin.end();
      let timer, hard, forced = false;
      try {
        const finished = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), closeMs); })]);
        if (!finished) {
          forced = true; child.kill('SIGTERM'); hard = setTimeout(() => child.kill('SIGKILL'), killMs); await exited;
        }
      } finally {
        clearTimeout(timer); clearTimeout(hard); unbind();
        child.stdout.off('end', outputEnded); child.stdout.off('close', outputEnded);
      }
      if (forced || protocolBad || terminal?.code !== 0 || terminal?.signal) throw fail();
    })();
    return closing;
  }
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), startupMs); })]);
    if (terminal || protocolBad) throw fail();
  } catch (error) { try { await close(); } catch {} throw error; }
  finally { clearTimeout(timer); }
  const stop = () => {
    if (!run || run.stopped || run.finished) return;
    run.stopped = true;
    run.cancelTimer = setTimeout(bad, cancelMs);
    try { writeFrame(child.stdin, {type: 'cancel'}); } catch { bad(); }
  };
  return {close, stop, execution: 'private_local', confidentialRemoteAvailable: false,
    get diagnostics() { return diagnostics === null ? null : JSON.parse(JSON.stringify(diagnostics)); },
    async run(prompt, {signal, approve = async () => false, onStatus = () => {}} = {}) {
      if (used || terminal || protocolBad || typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') ||
          Buffer.byteLength(prompt) > 65536 || typeof approve !== 'function' || typeof onStatus !== 'function') throw fail();
      used = true;
      const done = new Promise((resolve, reject) => { run = {
        resolve, reject, approve, onStatus, lastApproval: 0, lastCommands: 0, stopped: false, finished: false, cancelTimer: null,
      }; });
      signal?.addEventListener('abort', stop, {once: true});
      const deadline = setTimeout(() => { stop(); complete(fail()); }, 2430000);
      try {
        if (signal?.aborted) throw fail();
        writeFrame(child.stdin, {type: 'run', prompt});
        return await done;
      } finally { clearTimeout(deadline); clearTimeout(run?.cancelTimer); signal?.removeEventListener('abort', stop); run = null; }
    },
  };
}
class OpenCodeRuntime {
  static async start(config, {workspace, cooperation} = {}) {
    const checked = configuration(config, workspace);
    if (process.platform !== 'linux') throw fail();
    let publicTool;
    try {
      if (cooperation !== undefined) {
        if (!record(cooperation) || Object.keys(cooperation).length !== 2 ||
            typeof cooperation.socketPath !== 'string' || !Object.hasOwn(cooperation, 'snapshot')) throw fail();
        publicTool = await require('./cooperative-tool-server.cjs').startCooperativeTool(cooperation);
        // Never pass the actual public-service socket or its identity credentials
        // into OpenCode. This proxy exports only the exact owner-enrolled snapshot.
        checked.cooperativeSocketPath = publicTool.socketPath;
      }
      const child = spawn('/usr/bin/python3', ['-B', path.resolve(__dirname, '../scripts/opencode_session.py'),
        '--execute', JSON.stringify(checked), workspace], {
        cwd: '/', env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const runtime = await ownedOpenCode(child);
      if (!publicTool) return runtime;
      let closing;
      return {...runtime, publicDelegation: publicTool.observations,
        get diagnostics() { return runtime.diagnostics; },
        close() {
          closing ??= (async () => {
            const outcomes = await Promise.allSettled([runtime.close(), publicTool.close()]);
            if (outcomes.some(outcome => outcome.status === 'rejected')) throw fail();
          })();
          return closing;
        },
      };
    } catch (error) {
      if (publicTool) await publicTool.close().catch(() => {});
      throw error;
    }
  }
}
module.exports = {OpenCodeRuntime, configuration, ownedOpenCode};
