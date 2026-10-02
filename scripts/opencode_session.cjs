// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Runs only inside the owner-selected disposable namespace. Stdio is the
// editor bridge; OpenCode HTTP, credentials and model transport stay inside.
const fs = require('node:fs');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {OpenCodeClient} = require('../src/opencode-client.cjs');
const {OpenCodeTask} = require('../src/opencode-task.cjs');
const {PrivateConversation} = require('../src/private-conversation.cjs');
const {startChatCompletionsProvider} = require('../src/chat-completions-provider.cjs');
const {runtimeSettings, MODEL} = require('../src/opencode-config.cjs');
const {readFrames, writeFrame, taskFailure} = require('../src/opencode-bridge.cjs');
const COOPERATIVE_SOCKET = '/opt/core/cooperative.sock';

function cooperativeMounted() {
  let info;
  try { info = fs.lstatSync(COOPERATIVE_SOCKET); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const parent = fs.lstatSync('/opt/core');
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600 ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700) throw Error('cooperative-scope');
  return true;
}

function prepareState(cooperative) {
  for (const name of ['config', 'cache', 'data', 'state']) fs.mkdirSync(`/opt/state/${name}`, {recursive: true, mode: 0o700});
  if (!cooperative) return;
  const directory = '/opt/state/config/opencode/tools';
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.copyFileSync('/opt/src/opencode-cooperative-tool.js', `${directory}/volparossa.js`, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(`${directory}/volparossa.js`, 0o400);
  fs.chmodSync(directory, 0o500);
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
async function runSession({input, output, events = process}, hooks = {}) {
  const spawnServer = hooks.spawn ?? spawn;
  let provider, child, exited, client, task, running, closing = false, bad = false, requested = false;
  let seq = 0, pendingApproval, finish;
  const expiredApprovals = new Set();
  const ended = new Promise(resolve => { finish = resolve; });
  const abort = new AbortController();
  const send = value => { try { writeFrame(output, value); } catch { broken(); } };
  const stop = () => {
    closing = true; abort.abort(); pendingApproval?.resolve(false); pendingApproval = null; finish();
  };
  const broken = () => { bad = true; stop(); };
  const approve = proposal => new Promise(resolve => {
    if (closing || abort.signal.aborted || pendingApproval) { resolve(false); return; }
    const id = ++seq;
    if (id > 1024) { resolve(false); broken(); return; }
    const timer = setTimeout(() => {
      expiredApprovals.add(id); pendingApproval?.resolve(false);
    }, hooks.approvalMs ?? 29000);
    pendingApproval = {id, resolve(value) {
      clearTimeout(timer); if (pendingApproval?.id === id) pendingApproval = null;
      resolve(value === true);
    }};
    send({type: 'approval', id, proposal});
  });
  const cancelApproval = () => { pendingApproval?.resolve(false); };
  abort.signal.addEventListener('abort', cancelApproval);
  const unbind = readFrames(input, value => {
    if (value.type === 'cancel' && Object.keys(value).length === 1) { abort.abort(); return; }
    if (value.type === 'approval' && Object.keys(value).length === 3 && typeof value.accepted === 'boolean' &&
        expiredApprovals.delete(value.id)) return;
    if (value.type === 'approval' && Object.keys(value).length === 3 && typeof value.accepted === 'boolean' &&
        pendingApproval && value.id === pendingApproval.id) {
      pendingApproval.resolve(value.accepted && !abort.signal.aborted); pendingApproval = null; return;
    }
    if (value.type !== 'run' || Object.keys(value).length !== 2 || requested || !task || closing ||
        typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.includes('\0') ||
        Buffer.byteLength(value.prompt) > 65536) { broken(); return; }
    requested = true;
    running = task.run(value.prompt, {signal: abort.signal}).then(result => {
      if (!closing) send({type: 'result', result, diagnostics: provider?.diagnostics?.summary ?? null});
    }).catch(error => {
      bad = true;
      if (!closing) send({type: 'failed', reason: taskFailure(error),
        task_cleanup_failure: error?.taskCleanupFailure === 'session_cleanup_unconfirmed' ? 'session_cleanup_unconfirmed' : null,
        diagnostics: provider?.diagnostics?.summary ?? null});
    });
  }, broken);
  input.once('end', stop); input.once('close', stop); output.once('error', broken);
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.once(name, broken);
  try {
    await (hooks.preflight ?? (async () => {
      const core = new PrivateConversation('/opt/core/compute.sock');
      try {
        const caps = await core.connect();
        if (caps.model_profile !== MODEL || !caps.native_tool_template || !caps.local_only || caps.quarantined) throw Error('capabilities');
      } finally { core.close(); }
    }))();
    if (closing) throw Error('closed');
    provider = await (hooks.provider ?? startChatCompletionsProvider)({socketPath: '/opt/core/compute.sock', model: MODEL,
      diagnostics: true});
    const password = randomBytes(32).toString('hex');
    const cooperative = (hooks.cooperative ?? cooperativeMounted)();
    const settings = runtimeSettings({baseUrl: provider.baseUrl, bearerToken: provider.bearerToken, password, cooperative});
    (hooks.prepare ?? prepareState)(cooperative);
    const listen = await (hooks.port ?? port)();
    child = spawnServer('/opt/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(listen)], {
      cwd: '/workspace', env: settings.env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    exited = new Promise(resolve => {
      child.once('error', () => { broken(); resolve({code: null, signal: 'spawn_failed'}); });
      child.once('close', (code, signal) => { if (!closing) broken(); resolve({code, signal}); });
    });
    const deadline = Date.now() + 25000;
    while (!closing && Date.now() < deadline) {
      const Client = hooks.Client ?? OpenCodeClient;
      client = new Client({baseUrl: `http://127.0.0.1:${listen}`, password,
        username: 'volparossa', workspace: '/workspace', timeoutMs: 1000, cooperative});
      try { await client.connect(); break; }
      catch { client.close(); await delay(100); }
    }
    if (closing || !client?.ready) throw Error('startup');
    // Short readiness probes must not shorten normal permission/cleanup RPCs.
    client.timeoutMs = 30000;
    const Task = hooks.Task ?? OpenCodeTask;
    task = new Task(client, approve, {onStatus: status => send({type: 'status', ...status})});
    send({type: 'ready', version: 1, execution: 'private_local', confidentialRemoteAvailable: false});
    await ended;
  } catch { bad = true; }
  finally {
    stop();
    if (running) { try { await running; } catch { bad = true; } }
    client?.close();
    if (provider) {
      try {
        await provider.close();
        if (provider.observations.submitted !== provider.observations.cleanup_confirmed) bad = true;
      } catch { bad = true; }
    }
    if (child) {
      child.kill('SIGTERM');
      let timer;
      const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
      clearTimeout(timer);
      if (!result) { bad = true; child.kill('SIGKILL'); await exited; }
      else if (!(result.code === 0 || result.signal === 'SIGTERM')) bad = true;
    }
    abort.signal.removeEventListener('abort', cancelApproval);
    unbind(); input.off('end', stop); input.off('close', stop); output.off('error', broken);
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.off(name, broken);
  }
  return bad ? 1 : 0;
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.cwd() !== '/workspace' ||
      Object.keys(process.env).some(key => !['PATH', 'LANG'].includes(key))) return 1;
  return runSession({input: process.stdin, output: process.stdout});
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = {runSession, cooperativeMounted, prepareState};
