// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Lifecycle/protocol doubles only; the separate opt-in smoke runs real bwrap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {createWorkspaceVerifier} = require('../src/workspace-verifier.cjs');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'volparossa-verifier-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: false}));
  return directory;
}
function child(t, behavior) {
  const process = new EventEmitter();
  process.pid = 2000000000;
  process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.stdio = [null, process.stdout, process.stderr, new PassThrough(), new PassThrough(), null];
  process.kill = () => { process.finish(null, 'SIGKILL'); return true; };
  let finished = false;
  process.finish = (code = 0, signal = null) => {
    if (finished) return;
    finished = true;
    for (const stream of process.stdio.filter(Boolean)) stream.end();
    setImmediate(() => process.emit('close', code, signal));
  };
  process.status = (code = 0) => process.stdio[3].write(JSON.stringify({'child-pid': 7}) + '\n' +
    JSON.stringify({'exit-code': code}) + '\n');
  const killed = [];
  t.mock.method(global.process, 'kill', (pid, signal) => {
    killed.push([pid, signal]); process.kill(); return true;
  });
  const calls = [];
  t.mock.method(cp, 'spawn', (...args) => { calls.push(args); setImmediate(() => behavior(process)); return process; });
  return {calls, process, killed};
}
const invoke = (verifier, options = {}) => verifier({round: 1, remainingMs: 1000, ...options});

test('configuration is snapshotted before models and approval; no shell or inherited environment', async t => {
  const directory = workspace(t), args = ['literal;$(not-expanded)', '*.py'];
  let proposal;
  const verifier = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args,
    approve: value => { proposal = value; return true; }});
  args[0] = 'changed-by-caller'; args.push('new');
  const fixture = child(t, process => { process.status(); process.finish(); });
  assert.equal((await invoke(verifier)).status, 'passed');
  assert.equal(Object.isFrozen(proposal), true); assert.equal(Object.isFrozen(proposal.args), true);
  assert.deepEqual(proposal.args, ['literal;$(not-expanded)', '*.py']);
  const [command, actual, options] = fixture.calls[0];
  assert.equal(command, '/usr/bin/bwrap'); assert.equal(proposal.executable, '/usr/bin/true');
  assert.deepEqual(actual.slice(-4), ['--', '/usr/bin/true', ...proposal.args]);
  for (const required of ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop',
    '--ro-bind-fd', '--proc', '--dev', '--tmpfs', '--clearenv', '--json-status-fd', '--seccomp']) assert.ok(actual.includes(required));
  assert.deepEqual(actual.slice(actual.indexOf('--ro-bind-fd'), actual.indexOf('--ro-bind-fd') + 3),
    ['--ro-bind-fd', '5', '/workspace']);
  assert.equal(actual.includes('--share-net'), false); assert.equal(actual.includes('--bind'), false);
  assert.deepEqual(options.env, {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'});
  assert.equal(options.shell, false); assert.equal(options.cwd, '/'); assert.equal(options.detached, true);
  assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio.length, 6);
});

test('only completed real-status exits can pass/fail; bounded actual feedback is escaped not invented', async t => {
  const directory = workspace(t);
  for (const exit of [0, 1, 127]) {
    const fixture = child(t, process => {
      process.stdout.write('actual output\n\u001b[31m'); process.stderr.write('actual error\n');
      process.status(exit); process.finish(exit);
    });
    const result = await invoke(createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true}));
    assert.deepEqual(result, {status: exit === 0 ? 'passed' : 'failed',
      feedback: JSON.stringify({exit_code: exit, stdout: 'actual output\n\u001b[31m', stderr: 'actual error\n'})});
    assert.equal(result.feedback.includes('\n'), false);
    assert.equal(fixture.calls.length, 1);
    t.mock.restoreAll();
  }
});

test('ordinary multi-test error output remains a complete failed check', async t => {
  const directory = workspace(t), stderr = 'ordinary test failure\n'.repeat(69) + 'FAILED\n';
  assert.ok(Buffer.byteLength(stderr) > 1460 && Buffer.byteLength(stderr) < 4096);
  child(t, process => { process.stderr.write(stderr); process.status(1); process.finish(1); });
  const result = await invoke(createWorkspaceVerifier({workspace: directory,
    executable: '/usr/bin/true', args: [], approve: () => true}));
  assert.equal(result.status, 'failed');
  assert.deepEqual(JSON.parse(result.feedback), {exit_code: 1, stdout: '', stderr});
});

test('invalid configurations cannot create a host command path', t => {
  const directory = workspace(t), base = {workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true};
  for (const changes of [{executable: '/tmp/check'}, {executable: 'true'}, {args: 'true'}, {args: ['x\0y']},
    {args: ['x'.repeat(4097)]}, {args: Array(129).fill('x')}, {timeoutMs: 0}, {approve: null}, {workspace: os.homedir()}]) {
    assert.throws(() => createWorkspaceVerifier({...base, ...changes}));
  }
});

test('denial, cancellation and deadline during approval never spawn, including late approval', async t => {
  const directory = workspace(t);
  t.mock.method(cp, 'spawn', () => assert.fail('must not spawn'));
  const denied = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => false});
  assert.equal((await invoke(denied)).status, 'unavailable');
  const controller = new AbortController(); let accept;
  const pending = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [],
    approve: () => { controller.abort(); return new Promise(resolve => { accept = resolve; }); }});
  assert.equal((await invoke(pending, {signal: controller.signal})).status, 'unavailable'); accept(true);
  const expired = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], timeoutMs: 10,
    approve: () => new Promise(() => {})});
  assert.deepEqual(await invoke(expired), {status: 'unavailable', feedback: 'workspace_verifier_timeout'});
});

test('setup failure, malformed status, signals and bwrap diagnostics are never test failures', async t => {
  const directory = workspace(t);
  for (const behavior of [
    process => process.finish(1),
    process => { process.status(137); process.finish(137); },
    process => { process.status(); process.finish(null, 'SIGKILL'); },
    process => { process.status(); process.stderr.write('bwrap: execvp failed\n'); process.finish(); },
    process => { process.stdio[3].write('{bad\n'); process.finish(); },
    process => { process.stdio[3].write('{"exit-code":0}\n'); process.finish(); },
  ]) {
    child(t, behavior);
    const verifier = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true});
    assert.equal((await invoke(verifier)).status, 'unavailable');
    t.mock.restoreAll();
  }
});

test('cancel, timeout and output overflow kill the process group and join before returning', async t => {
  const directory = workspace(t);
  for (const reason of ['cancelled', 'timeout', 'output_limit']) {
    const controller = new AbortController();
    const fixture = child(t, process => {
      if (reason === 'cancelled') controller.abort();
      else if (reason === 'output_limit') process.stdout.write(Buffer.alloc(4097, 65));
    });
    const verifier = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [],
      timeoutMs: reason === 'timeout' ? 10 : 1000, approve: () => true});
    let joined = false; fixture.process.once('close', () => { joined = true; });
    assert.deepEqual(await invoke(verifier, {signal: controller.signal}),
      {status: 'unavailable', feedback: `workspace_verifier_${reason}`});
    assert.equal(joined, true);
    assert.deepEqual(fixture.killed, [[-fixture.process.pid, 'SIGKILL']]);
    assert.equal(fixture.calls.length, 1); t.mock.restoreAll();
  }
});

test('escaped feedback stays inside bridge bound and aggregate/status overflow stays unavailable', async t => {
  const directory = workspace(t);
  child(t, process => { process.stdout.write(Buffer.alloc(1024, 0)); process.status(); process.finish(); });
  const verifier = () => createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true});
  const result = await invoke(verifier());
  assert.equal(result.status, 'passed'); assert.ok(Buffer.byteLength(result.feedback) <= 8192);
  assert.equal(JSON.parse(result.feedback).stdout, '\0'.repeat(1024));
  t.mock.restoreAll();
  child(t, process => { process.stdout.write(Buffer.alloc(4096, 65)); process.status(1); process.finish(1); });
  const largest = await invoke(verifier());
  assert.equal(largest.status, 'failed'); assert.ok(Buffer.byteLength(largest.feedback) <= 8192);
  assert.equal(JSON.parse(largest.feedback).stdout, 'A'.repeat(4096));
  t.mock.restoreAll();
  child(t, process => { process.stdout.write(Buffer.alloc(2048, 0)); process.status(1); process.finish(1); });
  assert.deepEqual(await invoke(verifier()), {status: 'unavailable', feedback: 'workspace_verifier_output_limit'});
  t.mock.restoreAll();
  for (const behavior of [
    process => { process.stdout.write(Buffer.alloc(2048)); process.stderr.write(Buffer.alloc(2049)); },
    process => process.stdio[3].write(Buffer.alloc(4097)),
  ]) {
    const fixture = child(t, behavior);
    assert.deepEqual(await invoke(verifier()), {status: 'unavailable', feedback: 'workspace_verifier_output_limit'});
    assert.equal(fixture.killed.length, 1); t.mock.restoreAll();
  }
});

test('spawn failures never become failed checks and concurrent calls cannot start another command', async t => {
  const directory = workspace(t);
  const verifier = () => createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true});
  t.mock.method(cp, 'spawn', () => { throw Error('private launch details'); });
  assert.deepEqual(await invoke(verifier()), {status: 'unavailable', feedback: 'workspace_verifier_spawn_failed'});
  t.mock.restoreAll();
  const fixture = child(t, () => {}), active = verifier();
  const pending = invoke(active);
  assert.deepEqual(await invoke(active), {status: 'unavailable', feedback: 'workspace_verifier_busy'});
  await new Promise(resolve => setImmediate(resolve));
  fixture.process.status(); fixture.process.finish();
  assert.equal((await pending).status, 'passed'); assert.equal(fixture.calls.length, 1);
});

test('current workspace root cannot be exchanged after its identity was selected', async t => {
  const directory = workspace(t), moved = directory + '-moved';
  const verifier = createWorkspaceVerifier({workspace: directory, executable: '/usr/bin/true', args: [], approve: () => true});
  fs.renameSync(directory, moved); fs.mkdirSync(directory, {mode: 0o700});
  t.after(() => fs.rmSync(moved, {recursive: true, force: false}));
  t.mock.method(cp, 'spawn', () => assert.fail('exchanged root must not spawn'));
  assert.deepEqual(await invoke(verifier), {status: 'unavailable', feedback: 'workspace_verifier_workspace_changed'});
});
