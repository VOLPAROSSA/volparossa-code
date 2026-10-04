// SPDX-License-Identifier: GPL-3.0-only
// Native NDJSON transport owner. No prompts, task controller or tool approval here.
'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {PrivateConversation} = require('../src/private-conversation.cjs');
const {startResponsesProvider} = require('../src/responses-provider.cjs');
const {MODEL, modelCatalog, runtimeSettings} = require('../src/native-coding-fixture.cjs');

async function preflight() {
  const client = new PrivateConversation('/opt/core/compute.sock');
  try {
    const caps = await client.connect();
    if (caps.model_profile !== MODEL || !caps.native_tool_template || !caps.local_only || caps.quarantined) {
      throw Error('native_editor_capabilities');
    }
  } finally { client.close(); }
}

const defaults = {
  preflight,
  catalog() {
    const instructions = fs.readFileSync('/opt/upstream-prompt.md', 'utf8');
    fs.writeFileSync('/opt/catalog.json', JSON.stringify(modelCatalog(instructions)), {flag: 'wx', mode: 0o400});
  },
  provider: () => startResponsesProvider({socketPath: '/opt/core/compute.sock', model: MODEL}),
  spawn: (binary, args, options) => spawn(binary, args, options),
};

// Dependency seam is only for synthetic stream/process tests. CLI has no overrides.
async function runSession({input, output, ready, events = process}, hooks = defaults) {
  let provider, child, exited, stopped = false, bad = false, exit = null, closing = null;
  let wake;
  const stopRequested = new Promise(resolve => { wake = resolve; });
  const stop = () => { stopped = true; wake(); };
  const failed = () => { bad = true; stop(); };
  for (const name of ['end', 'close']) input.once(name, stop);
  input.once('error', failed); output.once('error', failed); output.once('close', stop);
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.once(name, failed);
  // Notice EOF even before the app-server is spawned; do not retain early bytes.
  input.pause();
  async function close() {
    closing ??= (async () => {
      input.unpipe(child?.stdin); input.pause();
      child?.stdin.end();
      if (provider) {
        try {
          await provider.close();
          // Current adapter does not expose successful cancel receipts separately.
          // Never call an interrupted/unconfirmed request verified cleanup.
          const seen = provider.observations;
          if (seen.submitted !== seen.cleanup_confirmed) bad = true;
        } catch { bad = true; }
      }
      if (child) {
        let timer, hard;
        try {
          exit = await Promise.race([exited, new Promise(resolve => {
            timer = setTimeout(() => resolve(null), 5000);
          })]);
          if (!exit) {
            bad = true; child.kill('SIGTERM');
            hard = setTimeout(() => child.kill('SIGKILL'), 5000);
            exit = await exited;
          }
          if (exit.code !== 0 || exit.signal) bad = true;
        } finally { clearTimeout(timer); clearTimeout(hard); }
      }
    })();
    return closing;
  }
  try {
    await hooks.preflight();
    if (stopped || input.destroyed || input.readableEnded) throw Error('editor_input_closed');
    hooks.catalog();
    provider = await hooks.provider();
    if (stopped || input.destroyed || input.readableEnded) throw Error('editor_input_closed');
    child = hooks.spawn('/opt/codex-app-server', ['--listen', 'stdio://', '--strict-config',
      ...runtimeSettings(provider.baseUrl).flatMap(value => ['-c', value])], {
      cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', VOLPAROSSA_PROVIDER_TOKEN: provider.bearerToken},
    });
    exited = new Promise(resolve => {
      child.once('error', () => { failed(); resolve({code: null, signal: 'spawn_failed'}); });
      child.once('close', (code, signal) => { stop(); resolve({code, signal}); });
    });
    child.stdin.on('error', failed); child.stdout.on('error', failed);
    let stderrBytes = 0;
    child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 1048576) failed(); });
    child.stderr.on('error', failed); // Discard raw stderr, including paths and secrets.
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (stopped) throw Error('editor_input_closed');
    child.stdout.pipe(output, {end: false});
    input.pipe(child.stdin);
    ready();
    await stopRequested;
  } catch { bad = true; }
  finally {
    await close();
    for (const name of ['end', 'close']) input.removeListener(name, stop);
    input.removeListener('error', failed); output.removeListener('error', failed); output.removeListener('close', stop);
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.removeListener(name, failed);
  }
  return bad ? 1 : 0;
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.cwd() !== '/workspace' ||
      Object.keys(process.env).some(key => !['PATH', 'LANG'].includes(key))) return 1;
  return runSession({input: process.stdin, output: process.stdout, ready() {
    fs.writeSync(2, '{"native_editor_ready":true}\n');
  }});
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = {runSession};
