// SPDX-License-Identifier: GPL-3.0-only
// Synthetic transport/lifecycle checks. No native runtime, model or real project executes.
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const {PassThrough} = require('node:stream');
const {EventEmitter, once} = require('node:events');
const path = require('node:path');
const {configuration, ownedSession, NativeRuntime} = require('../src/editor-runtime.cjs');
const {runSession} = require('../scripts/editor_session.cjs');
const root = path.resolve(__dirname, '..');

function python(source) {
  const result = spawnSync('/usr/bin/python3', ['-B', '-c',
    "import sys; sys.path.insert(0,'scripts')\nimport editor_session as s\n" + source],
  {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
}

test('editor configuration has only explicit pinned runtime/node/prompt/core inputs', async () => {
  const config = {version: 1, appServer: '/fixture/runtime/codex-app-server', appServerSha256: 'a'.repeat(64),
    buildReport: '/fixture/BUILD_REPORT.json', node: '/fixture/node', nodeSha256: 'b'.repeat(64),
    upstreamPrompt: '/fixture/prompt.md', socketPath: '/fixture/private/core.sock'};
  assert.deepEqual(configuration(config, '/fixture/project'), config);
  for (const changed of [{...config, command: 'injected'}, {...config, nodeSha256: 'bad'},
    {...config, socketPath: 'relative'}, {...config, version: 2}, {...config, appServer: '/x\0bad'}]) {
    assert.throws(() => configuration(changed, '/fixture/project'), /native_editor_runtime/);
  }
  await assert.rejects(NativeRuntime.start(config, {workspace: 'relative'}), /native_editor_runtime/);
});

test('sparse sandbox binds only the selected project RW with isolated network and no environment override', () => {
  python(String.raw`
from pathlib import Path
c=s.command(Path('/f/runtime'),Path('/f/node'),Path('/f/core/socket'),Path('/f/prompt'),
            Path('/f/project'),'/home/fixture')
triples=[c[i:i+3] for i in range(len(c)-2)]
assert [t for t in triples if t[0]=='--bind']==[['--bind','/f/project','/workspace']]
assert ['--ro-bind','/f/core/socket','/opt/core/compute.sock'] in triples
assert ['--ro-bind','/etc/passwd','/etc/passwd'] in triples
assert not any(t[0]=='--ro-bind' and t[1] in ('/','/home','/home/fixture','/f') for t in triples)
for flag in ('--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--clearenv'):
 assert flag in c
assert '--preserve-fds' not in c
assert c[c.index('--chdir')+1]=='/workspace'
assert [t for t in triples if t[0]=='--setenv']==[
 ['--setenv','PATH','/usr/bin:/bin'],['--setenv','LANG','C.UTF-8']]
assert all('fixture.py' not in arg and 'smoke_native_coding.cjs' not in arg for arg in c)
`);
});

test('owner selection rejects broad roots, symlinks, writable-by-others projects and authority overlap', () => {
  python(String.raw`
from pathlib import Path
import tempfile,os
with tempfile.TemporaryDirectory() as temporary:
 root=Path(temporary); project=root/'project'; project.mkdir(mode=0o700)
 assert s.selected_workspace(str(project),[root/'runtime'],str(root/'home'))==project
 alias=root/'alias'; alias.symlink_to(project)
 for candidate,inputs,home in [('/',[],str(root/'home')),('/tmp',[],str(root/'home')),
    (str(alias),[],str(root/'home')),(str(project),[project/'runtime'],str(root/'home')),
    (str(project),[],str(project))]:
  try:s.selected_workspace(candidate,inputs,home)
  except ValueError:pass
  else:raise AssertionError('unsafe selection accepted')
 try:s.selected_workspace(str(project),[],str(root/'home'),protected=(root,))
 except ValueError:pass
 else:raise AssertionError('launcher/runtime descendant accepted')
 project.chmod(0o777)
 try:s.selected_workspace(str(project),[],str(root/'home'))
 except ValueError:pass
 else:raise AssertionError('shared writable project accepted')
 try:s.no_duplicates([('version',1),('version',1)])
 except ValueError:pass
 else:raise AssertionError('duplicate config accepted')
`);
});

test('inside accepts bubblewrap-generated workspace PWD, never inherited home/config or another cwd', () => {
  python(String.raw`
s.clean_environment({'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PWD':'/workspace'})
s.clean_environment({'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
for change in ({'PWD':'/host/project'},{'HOME':'/home/owner'},{'CODEX_HOME':'/private'},
               {'OPENAI_API_KEY':'synthetic-secret'}):
 try:s.clean_environment({'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PWD':'/workspace'}|change)
 except ValueError:pass
 else:raise AssertionError('host environment accepted')
`);
});

test('runtime file binding rejects modified hashes or writable executable, socket requires same-owner private directory', () => {
  python(String.raw`
from pathlib import Path
import tempfile,hashlib,socket
with tempfile.TemporaryDirectory() as temporary:
 root=Path(temporary); binary=root/'runtime'; binary.write_bytes(b'synthetic-not-an-executable')
 binary.chmod(0o700); sha=hashlib.sha256(binary.read_bytes()).hexdigest()
 assert s.owned(s.verified_file(str(binary),sha,executable=True))==binary
 for expected,mode in [('0'*64,0o700),(sha,0o777)]:
  binary.chmod(mode)
  try:s.owned(s.verified_file(str(binary),expected,executable=True))
  except ValueError:pass
  else:raise AssertionError('runtime binding lost')
 private=root/'private'; private.mkdir(mode=0o700); ipc=private/'compute.sock'
 with socket.socket(socket.AF_UNIX) as server:
  server.bind(str(ipc)); ipc.chmod(0o600)
  assert s.private_socket(str(ipc))==ipc
  private.chmod(0o755)
  try:s.private_socket(str(ipc))
  except ValueError:pass
  else:raise AssertionError('nonprivate socket accepted')
`);
});

function syntheticInner({unconfirmed = false, providerThrows = false} = {}) {
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter();
  let bytes = Buffer.alloc(0), closes = 0, children = 0, ready;
  output.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); });
  const started = new Promise(resolve => { ready = resolve; });
  const hooks = {preflight: async () => {}, catalog() {},
    provider: async () => ({baseUrl: 'http://127.0.0.1:1234/v1', bearerToken: 'synthetic-secret',
      observations: {submitted: unconfirmed ? 1 : 0, cleanup_confirmed: 0},
      async close() { closes++; if (providerThrows) throw Error('private-sentinel'); }}),
    spawn(binary, args, options) {
      children++;
      assert.equal(binary, '/opt/codex-app-server'); assert.equal(options.cwd, '/workspace');
      assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH', 'VOLPAROSSA_PROVIDER_TOKEN']);
      assert(args.includes('model_provider="volparossa"'));
      assert(!args.some(value => /fixture.py|TASK|HOME/.test(value)));
      // A small echo process, not native Codex and not an inference substitute.
      return spawn(process.execPath, ['-e',
        'process.stderr.write("private-sentinel"); process.stdin.pipe(process.stdout);'],
      {stdio: ['pipe', 'pipe', 'pipe'], env: options.env});
    }};
  const done = runSession({input, output, events, ready}, hooks);
  return {input, output, events, started, done, get bytes() { return bytes; },
    get closes() { return closes; }, get children() { return children; }};
}

test('inner owner transparently forwards NDJSON, discards raw stderr and joins provider on EOF', async () => {
  const fixture = syntheticInner(); await fixture.started;
  const request = Buffer.from('{"id":1,"method":"initialize","params":{"private":"local"}}\n');
  fixture.input.end(request);
  assert.equal(await fixture.done, 0); assert.deepEqual(fixture.bytes, request);
  assert.equal(fixture.closes, 1); assert.equal(fixture.children, 1);
  assert.equal(fixture.events.listenerCount('SIGTERM'), 0);
});

test('inner owner never calls missing cleanup or provider failure successful', async () => {
  for (const options of [{unconfirmed: true}, {providerThrows: true}]) {
    const fixture = syntheticInner(options); await fixture.started; fixture.input.end();
    assert.equal(await fixture.done, 1); assert.equal(fixture.closes, 1);
  }
});

test('inner owner handles signal by closing the provider and child, without protocol diagnostics', async () => {
  const fixture = syntheticInner(); await fixture.started; fixture.events.emit('SIGTERM');
  assert.equal(await fixture.done, 1); assert.equal(fixture.closes, 1);
  assert.equal(fixture.bytes.length, 0);
});

function syntheticOuter(program) {
  return spawn(process.execPath, ['-e', program], {stdio: ['pipe', 'pipe', 'pipe'],
    env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
}
test('outer readiness is separate from NDJSON and close is idempotent with a joined process', async () => {
  const child = syntheticOuter('process.stderr.write(\'{"native_editor_ready":true}\\n\'); process.stdin.pipe(process.stdout);');
  const session = await ownedSession(child, {closeMs: 1000});
  const chunks = []; session.readable.on('data', chunk => chunks.push(chunk));
  const seen = once(session.readable, 'data');
  session.writable.write('{"synthetic":true}\n'); await seen;
  await Promise.all([session.close(), session.close()]);
  assert.equal(Buffer.concat(chunks).toString(), '{"synthetic":true}\n');
  assert.equal(child.exitCode, 0);
});

test('outer failures are generic and forced stop is never a cleanup success', async () => {
  const failed = syntheticOuter('process.stderr.write("private-path-and-token\\n"); process.exitCode=1;');
  await assert.rejects(ownedSession(failed, {startupMs: 1000, closeMs: 1000}),
    error => error.message === 'native_editor_runtime_unavailable_or_cleanup_unconfirmed');
  const stuck = syntheticOuter('process.stderr.write(\'{"native_editor_ready":true}\\n\'); setInterval(()=>{},1000);');
  const session = await ownedSession(stuck, {closeMs: 30, killMs: 30});
  await assert.rejects(session.close(), /cleanup_unconfirmed/);
  await assert.rejects(session.close(), /cleanup_unconfirmed/);
  assert(stuck.signalCode);
});
