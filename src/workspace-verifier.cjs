// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const {performance} = require('node:perf_hooks');

const BWRAP = '/usr/bin/bwrap';
// Even worst-case JSON escaping fits the bridge's 8192-byte feedback bound.
const OUTPUT_BYTES = 1024, STATUS_BYTES = 4096;
const ENV = Object.freeze({PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'});
const unavailable = reason => ({status: 'unavailable', feedback: `workspace_verifier_${reason}`});
const validText = value => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= 4096;
const identity = info => `${info.dev}:${info.ino}`;
const version = info => `${identity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function trustedExecutable(file) {
  if (!validText(file) || !path.isAbsolute(file)) throw Error('workspace_verifier_configuration');
  const canonical = fs.realpathSync(file), info = fs.statSync(canonical);
  if (path.dirname(canonical) !== '/usr/bin' || !info.isFile() || info.uid !== 0 || (info.mode & 0o6022)) {
    throw Error('workspace_verifier_configuration');
  }
  fs.accessSync(canonical, fs.constants.X_OK);
  return Object.freeze({path: canonical, version: version(info)});
}

// Linux x86-64 cBPF: fail other ABIs closed, forbid creating sockets (including
// pathname Unix sockets in the workspace), and close the io_uring socket bypass.
// Only stdio plus bwrap's setup/status descriptors are inherited by bwrap.
function noSocketsFilter() {
  const instructions = [
    [0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
    [0x15, 0, 1, 41], [0x06, 0, 0, 0x00050001],
    [0x15, 0, 1, 53], [0x06, 0, 0, 0x00050001],
    [0x15, 0, 1, 425], [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], index) => {
    const offset = index * 8;
    bytes.writeUInt16LE(code, offset); bytes[offset + 2] = yes; bytes[offset + 3] = no;
    bytes.writeUInt32LE(value, offset + 4);
  });
  return bytes;
}

function sandboxArguments(executable, args) {
  return ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind-fd', '5', '/workspace', '--chdir', '/workspace', '--clearenv',
    '--setenv', 'PATH', ENV.PATH, '--setenv', 'LANG', ENV.LANG,
    '--json-status-fd', '3', '--seccomp', '4', '--', executable, ...args];
}

function completedStatus(bytes) {
  if (!bytes.endsWith('\n')) return null;
  let pid, exit;
  try {
    for (const line of bytes.trim().split('\n')) {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      if (Object.hasOwn(value, 'child-pid')) {
        if (pid !== undefined || !Number.isSafeInteger(value['child-pid']) || value['child-pid'] <= 0) return null;
        pid = value['child-pid'];
      }
      if (Object.hasOwn(value, 'exit-code')) {
        if (pid === undefined || exit !== undefined || !Number.isInteger(value['exit-code'])) return null;
        exit = value['exit-code'];
      }
    }
  } catch { return null; }
  // bwrap encodes a signal as 128+n. A high normal exit is indistinguishable;
  // conservatively do not call either one a completed test failure.
  return pid !== undefined && exit >= 0 && exit < 128 ? exit : null;
}

/** Capture owner configuration before a model runs; never accept model commands.
 * A pass means only this selected check exited successfully on current files.
 * It is not immutable-test integrity or a general correctness assertion.
 */
function createWorkspaceVerifier({workspace, executable, args, timeoutMs = 15000, approve} = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() <= 0 ||
      !validText(workspace) || !path.isAbsolute(workspace) || !Array.isArray(args) || args.length > 128 ||
      !args.every(validText) || args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 16384 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof approve !== 'function') {
    throw Error('workspace_verifier_configuration');
  }
  const directory = fs.realpathSync(workspace), info = fs.statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) ||
      directory === '/' || directory === fs.realpathSync(os.homedir())) throw Error('workspace_verifier_configuration');
  const workspaceIdentity = identity(info), command = trustedExecutable(executable), sandbox = trustedExecutable(BWRAP);
  const argv = Object.freeze([...args]);
  let running = false;
  return async function verify({round, remainingMs, signal} = {}) {
    if (running) return unavailable('busy');
    if (!Number.isSafeInteger(round) || round < 1 || round > 256 || !Number.isFinite(remainingMs) || remainingMs <= 0 ||
        (signal !== undefined && !(signal instanceof AbortSignal))) return unavailable('invalid_request');
    if (signal?.aborted) return unavailable('cancelled');
    running = true;
    const deadline = performance.now() + Math.min(timeoutMs, remainingMs);
    let timer, abort, child, workspaceFd, childClosed, stopped, closed = false;
    let resolveStop;
    const stopPromise = new Promise(resolve => { resolveStop = resolve; });
    const stop = reason => {
      if (stopped || closed) return;
      stopped = reason; resolveStop(false);
      if (child && Number.isSafeInteger(child.pid)) {
        // bwrap is its own host process group; its private PID-namespace reaper
        // and die-with-parent cascade also kill children that created sessions.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    try {
      abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, {once: true});
      timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - performance.now()));
      const proposal = Object.freeze({type: 'workspace_verifier', workspace: directory,
        executable: command.path, args: argv, round, timeoutMs: Math.min(timeoutMs, remainingMs)});
      const authorized = await Promise.race([
        Promise.resolve().then(() => approve(proposal)).then(value => value === true, () => false), stopPromise,
      ]);
      if (stopped || signal?.aborted || performance.now() >= deadline) return unavailable(stopped || 'timeout');
      if (!authorized) return unavailable('not_authorized');
      if (version(fs.statSync(command.path)) !== command.version || fs.realpathSync(command.path) !== command.path ||
          version(fs.statSync(sandbox.path)) !== sandbox.version || fs.realpathSync(sandbox.path) !== sandbox.path) {
        return unavailable('executable_changed');
      }
      workspaceFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (identity(fs.fstatSync(workspaceFd)) !== workspaceIdentity) return unavailable('workspace_changed');
      if (signal?.aborted || performance.now() >= deadline) return unavailable(signal?.aborted ? 'cancelled' : 'timeout');
      const result = await new Promise(resolve => {
        const chunks = {stdout: [], stderr: [], status: []};
        let outputBytes = 0, statusBytes = 0;
        try {
          child = childProcess.spawn(sandbox.path, sandboxArguments(command.path, argv), {
            cwd: '/', env: ENV, detached: true, shell: false,
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', workspaceFd],
          });
        } catch { resolve(unavailable('spawn_failed')); return; }
        childClosed = new Promise(joined => child.once('close', joined));
        fs.closeSync(workspaceFd); workspaceFd = undefined;
        child.once('error', () => stop('spawn_failed'));
        for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr], ['status', child.stdio[3]]]) {
          stream.on('data', data => {
            if (stopped) return;
            if (name === 'status') statusBytes += data.length; else outputBytes += data.length;
            if (outputBytes > OUTPUT_BYTES || statusBytes > STATUS_BYTES) { stop('output_limit'); return; }
            chunks[name].push(Buffer.from(data));
          });
          stream.on('error', () => stop('stream_failed'));
        }
        child.stdio[4].on('error', () => stop('sandbox_unavailable'));
        child.once('close', (code, childSignal) => {
          closed = true;
          if (!stopped && (signal?.aborted || performance.now() >= deadline)) stopped = signal?.aborted ? 'cancelled' : 'timeout';
          if (stopped) { resolve(unavailable(stopped)); return; }
          const exit = completedStatus(Buffer.concat(chunks.status).toString('utf8'));
          const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
          if (childSignal || exit === null || code !== exit || /(^|\n)bwrap:/.test(stderr)) {
            resolve(unavailable('sandbox_or_signal')); return;
          }
          resolve({status: exit === 0 ? 'passed' : 'failed',
            feedback: JSON.stringify({exit_code: exit, stdout, stderr})});
        });
        child.stdio[4].end(noSocketsFilter());
      });
      return result;
    } catch {
      if (child && !closed) { stop('internal_failure'); await childClosed; }
      return unavailable(stopped || 'configuration_changed');
    }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (workspaceFd !== undefined) fs.closeSync(workspaceFd);
      running = false;
    }
  };
}

module.exports = {createWorkspaceVerifier};
