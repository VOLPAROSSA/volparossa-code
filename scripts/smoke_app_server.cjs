// SPDX-License-Identifier: GPL-3.0-only
// Real app-server lifecycle only: no fake inference result and no turn/tool request.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {AppServer} = require('/opt/app-server-client.cjs');

const settings = [
  'model="volparossa-runtime-probe"', 'model_provider="volparossa"',
  'model_providers.volparossa.name="VOLPAROSSA"',
  'model_providers.volparossa.base_url="http://127.0.0.1:9/v1"',
  'model_providers.volparossa.wire_api="responses"',
  'model_providers.volparossa.requires_openai_auth=false',
  'model_providers.volparossa.supports_websockets=false',
  'check_for_update_on_startup=false', 'analytics.enabled=false', 'feedback.enabled=false',
  'web_search="disabled"', 'mcp_servers={}',
];

async function main() {
  assert.equal(process.cwd(), '/opt/work/project');
  assert.notEqual(process.getuid(), 0);
  for (const name of ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    assert.equal(process.env[name], undefined);
  }
  const report = {version: 1, phase: 'launch', success: false,
    initialize: false, thread_started: false, provider_selected: false,
    ephemeral: false, thread_unsubscribed: false,
    inference_proven: false, tools_proven: false, core_model_connection_proven: false,
    runtime_exit: null, forced_stop: false, diagnostic: null};
  const child = spawn('/opt/codex-app-server', ['--listen', 'stdio://', '--strict-config',
    ...settings.flatMap(value => ['-c', value])], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderrBytes = 0, overflow = false, spawnFailed = false;
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024 && !overflow) { overflow = true; child.kill('SIGTERM'); }
  }); // Raw diagnostics are not retained, displayed or exported.
  const exited = new Promise(resolve => {
    child.once('error', () => { spawnFailed = true; resolve({code: null, signal: null}); });
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  const client = new AppServer(child.stdout, child.stdin, {timeoutMs: 30000});
  try {
    report.phase = 'initialize';
    const initialized = await client.initialize();
    assert(initialized && typeof initialized.userAgent === 'string' && initialized.userAgent.length <= 4096);
    report.initialize = true;
    report.phase = 'thread-start';
    const started = await client.startThread({model: 'volparossa-runtime-probe', cwd: process.cwd()});
    assert(started.thread && typeof started.thread.id === 'string' && started.thread.id.length <= 256);
    assert.equal(started.thread.modelProvider, 'volparossa');
    assert.equal(started.thread.ephemeral, true);
    assert.equal(started.model, 'volparossa-runtime-probe');
    assert.equal(started.cwd, process.cwd());
    report.thread_started = report.provider_selected = report.ephemeral = true;
    report.phase = 'thread-unsubscribe';
    const unsubscribed = await client.request('thread/unsubscribe', {threadId: started.thread.id});
    assert.equal(unsubscribed.status, 'unsubscribed');
    report.thread_unsubscribed = true;
  } catch (error) {
    const known = new Set(['app_server_rejected', 'rpc_closed', 'rpc_unavailable', 'thread_scope']);
    report.diagnostic = known.has(error.message) ? error.message : 'lifecycle_check_failed';
  } finally {
    report.phase = report.diagnostic ? report.phase : 'shutdown';
    client.close();
    let timer;
    const graceful = await Promise.race([exited, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), 10000);
    })]);
    clearTimeout(timer);
    let result = graceful;
    if (!result) {
      report.forced_stop = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      result = await exited;
      clearTimeout(force);
    }
    report.runtime_exit = result.code;
    report.stderr_bounded = !overflow;
    report.success = report.thread_unsubscribed && !report.diagnostic && !report.forced_stop
      && !spawnFailed && !overflow && result.code === 0 && result.signal === null;
    if (report.success) report.phase = 'complete';
    fs.writeFileSync('/opt/work/receipt.json', JSON.stringify(report) + '\n', {flag: 'wx', mode: 0o600});
    if (!report.success) process.exitCode = 1;
  }
}
main().catch(() => { process.exitCode = 1; });
