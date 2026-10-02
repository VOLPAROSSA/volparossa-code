// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Explicit local namespace smoke only. No model, network, install or VM involved.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {createWorkspaceVerifier} = require('../src/workspace-verifier.cjs');

const CHECK = 'from fixture import add\nassert add(2, 3) == 5, "selected addition check failed"\nprint("selected addition check passed")';
const ISOLATION = `import errno, os, socket
assert not os.path.exists('/home') and not os.path.exists('/run')
assert os.getcwd() == '/workspace'
assert 'HOME' not in os.environ
try:
    open('/workspace/forbidden-write', 'w')
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM)
else:
    raise AssertionError('workspace writable')
for kind in (socket.AF_UNIX, socket.AF_INET):
    try:
        connection = socket.socket(kind, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        if kind == socket.AF_UNIX:
            connection.connect('/workspace/host-sentinel.sock')
        raise AssertionError('socket creation allowed')
print('readonly workspace and socket isolation checked')
`;

async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && args[0] === '--preview')) {
    const preview = {execute: false, actual_inference: false,
      scope: 'explicit disposable workspace, unprivileged bwrap, real selected check only',
      usage: '--execute --yes'};
    process.stdout.write(JSON.stringify(preview) + '\n'); return preview;
  }
  if (args.length !== 2 || args[0] !== '--execute' || args[1] !== '--yes') throw Error('smoke_arguments');
  const controller = new AbortController(), interrupt = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, interrupt);
  let directory, server, accepts = 0;
  const result = {version: 1, passed: false, actual_inference: false, general_quality_proven: false,
    baseline: 'unavailable', corrected: 'unavailable', isolation: 'unavailable', cancellation: 'unavailable',
    workspace_removed: false, host_socket_connections: 0, failure: null};
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volparossa-verifier-smoke-'));
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, 'fixture.py'), 'def add(a, b):\n    return a - b\n', {mode: 0o600, flag: 'wx'});
    const verifier = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/python3',
      args: ['-B', '-c', CHECK], approve: () => true}); // Explicit --execute --yes authorizes these fixed checks.
    result.baseline = (await verifier({round: 1, remainingMs: 15000, signal: controller.signal})).status;
    if (result.baseline !== 'failed') throw Error('baseline_unavailable_or_unexpected');
    // Owner-controlled fixture change, never a model answer or verifier repair.
    await fs.writeFile(path.join(directory, 'fixture.py'), 'def add(a, b):\n    return a + b\n', {mode: 0o600});
    result.corrected = (await verifier({round: 2, remainingMs: 15000, signal: controller.signal})).status;
    if (result.corrected !== 'passed') throw Error('corrected_unavailable_or_failed');
    server = net.createServer(socket => { accepts++; socket.destroy(); });
    server.listen(path.join(directory, 'host-sentinel.sock')); await once(server, 'listening');
    const isolation = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/python3',
      args: ['-B', '-c', ISOLATION], approve: () => true});
    result.isolation = (await isolation({round: 1, remainingMs: 15000, signal: controller.signal})).status;
    result.host_socket_connections = accepts;
    if (result.isolation !== 'passed' || accepts !== 0) throw Error('isolation_failed');
    const cancellation = new AbortController();
    const pending = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/python3',
      args: ['-B', '-c', 'import os, time\npid = os.fork()\nif pid == 0: os.setsid()\ntime.sleep(30)'],
      approve: () => true})({round: 1, remainingMs: 15000, signal: cancellation.signal});
    const cancelTimer = setTimeout(() => cancellation.abort(), 100);
    try {
      const cancelled = await pending;
      result.cancellation = cancelled.status;
      if (cancelled.feedback !== 'workspace_verifier_cancelled') throw Error('cancellation_not_observed');
    }
    finally { clearTimeout(cancelTimer); cancellation.abort(); }
    if (result.cancellation !== 'unavailable') throw Error('cancellation_not_closed');
    result.passed = true;
  } catch {
    result.failure = 'isolated_verifier_smoke_unavailable_or_failed';
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) {
      try { await fs.rm(directory, {recursive: true, force: false}); result.workspace_removed = true; }
      catch { result.failure = 'workspace_cleanup_unconfirmed'; }
    }
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, interrupt);
    result.passed = result.passed && result.workspace_removed && result.failure === null;
  }
  // Never log captured command output, even on failure.
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.passed) process.exitCode = 1;
  return result;
}

if (require.main === module) main().catch(() => {
  process.stderr.write('{"passed":false,"failure":"verifier_smoke_input"}\n'); process.exitCode = 1;
});
module.exports = {main};
