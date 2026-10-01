// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const FIELDS = ['version', 'appServer', 'appServerSha256', 'buildReport', 'node',
  'nodeSha256', 'upstreamPrompt', 'socketPath'];
const fail = () => Error('native_editor_runtime_unavailable_or_cleanup_unconfirmed');

function configuration(config, workspace) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(config, key)) ||
      config.version !== 1) throw fail();
  for (const key of FIELDS.slice(1)) {
    const value = config[key];
    if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 4096 ||
        (key.endsWith('Sha256') ? !/^[a-f0-9]{64}$/.test(value) : !path.isAbsolute(value))) throw fail();
  }
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0') ||
      Buffer.byteLength(workspace) > 4096) throw fail();
  return {...config};
}

// Exposed for synthetic process/stream lifecycle tests, not a configurable executable.
async function ownedSession(child, {startupMs = 30000, closeMs = 45000, killMs = 5000} = {}) {
  let terminal = null, forced = false, closing = null;
  const exited = new Promise(resolve => {
    const done = (code, signal) => { terminal ??= {code, signal}; resolve(terminal); };
    child.once('error', () => done(null, 'spawn_failed'));
    child.once('close', done);
  });
  child.stdin.on('error', () => {}); // AppServer also receives the stream failure.
  child.stdout.on('error', () => {});
  async function close() {
    closing ??= (async () => {
      child.stdin.end();
      let timer, hard;
      try {
        const result = await Promise.race([exited, new Promise(resolve => {
          timer = setTimeout(() => resolve(null), closeMs);
        })]);
        if (!result) {
          forced = true; child.kill('SIGTERM');
          hard = setTimeout(() => child.kill('SIGKILL'), killMs);
          await exited;
        }
      } finally { clearTimeout(timer); clearTimeout(hard); child.stderr?.destroy(); }
      if (forced || terminal?.code !== 0 || terminal?.signal) throw fail();
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0), done = false;
      // bwrap only promises stdio inheritance. Native stderr is discarded by
      // the inner owner; accept just one exact content-free readiness line.
      const status = child.stderr;
      const timer = setTimeout(() => finish(false), startupMs);
      const finish = okay => {
        if (done) return; done = true; clearTimeout(timer);
        status?.removeListener('data', data); status?.removeListener('end', end);
        status?.removeListener('error', bad); child.removeListener('close', bad); child.removeListener('error', bad);
        // Continue draining without retaining or emitting any raw stderr.
        if (okay) { status.on('error', () => {}); status.resume(); }
        okay ? resolve() : reject(fail());
      };
      const data = chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 64) finish(false);
        else if (received.includes(10)) finish(received.toString() === '{"native_editor_ready":true}\n');
      };
      const end = () => finish(false);
      const bad = () => finish(false);
      if (!status || terminal) { finish(false); return; }
      status.on('data', data); status.once('end', end); status.once('error', bad);
      child.once('close', bad); child.once('error', bad);
    });
    if (terminal) throw fail();
    return {readable: child.stdout, writable: child.stdin, close};
  } catch {
    try { await close(); } catch {}
    throw fail();
  }
}

class NativeRuntime {
  static async start(config, {workspace} = {}) {
    const checked = configuration(config, workspace);
    if (process.platform !== 'linux') throw fail();
    // Fixed interpreter and launcher; no shell, inherited secrets or user-selected command.
    const child = spawn('/usr/bin/python3', ['-B', path.resolve(__dirname, '../scripts/editor_session.py'),
      '--execute', JSON.stringify(checked), workspace], {
      cwd: '/', env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return ownedSession(child);
  }
  start(config, options) { return NativeRuntime.start(config, options); }
}
module.exports = {NativeRuntime, configuration, ownedSession};
