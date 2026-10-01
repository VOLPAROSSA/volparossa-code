// SPDX-License-Identifier: GPL-3.0-only
// Offline policy/helper checks, not native model or coding-loop evidence.
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {MODEL, PROJECT, PROMPT_SHA256, modelCatalog, runtimeSettings, commandKind, authorize} = require('../src/native-coding-fixture.cjs');
const root = path.join(__dirname, '..');

function python(source) {
  const result = spawnSync('python3', ['-B', '-c', source], {cwd: root, encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
}

test('native catalog refuses a replaced prompt; local pinned prompt is retained without truncation', t => {
  assert.throws(() => modelCatalog('short replacement instructions'), /native_prompt_mismatch/);
  const prompt = path.resolve(root, '..', 'upstream-codex/codex-rs/models-manager/prompt.md');
  if (!fs.existsSync(prompt)) { t.diagnostic('Pinned upstream source absent; positive catalog check not run.'); return; }
  const original = fs.readFileSync(prompt, 'utf8');
  const {models: [model]} = modelCatalog(original);
  assert.equal(model.slug, MODEL);
  assert.equal(model.model_messages.instructions_template, original);
  assert.equal(Buffer.byteLength(original), 20903);
  assert.equal(model.apply_patch_tool_type, null);
  assert.equal(model.supports_reasoning_summary_parameter, false);
  assert.equal(model.shell_type, 'unified_exec'); assert.equal(model.tool_mode, 'direct');
  assert.equal(model.input_modalities.length, 1);
  assert.equal(model.context_window, 32768);
});

test('native configuration has no cloud login, retries, inherited external tools or secret-bearing shell environment', () => {
  const settings = runtimeSettings('http://127.0.0.1:12345/v1');
  for (const value of ['model="qwen3-0.6b-v1"', 'model_provider="volparossa"',
    'model_providers.volparossa.requires_openai_auth=false', 'model_providers.volparossa.request_max_retries=0',
    'model_providers.volparossa.stream_max_retries=0', 'features.apps=false', 'features.plugins=false',
    'features.view_image=false', 'model_reasoning_summary="none"', 'mcp_servers={}',
    'shell_environment_policy.exclude=["VOLPAROSSA_PROVIDER_TOKEN"]']) assert(settings.includes(value));
  assert(!settings.some(value => /OPENAI|danger-full-access|approval_policy="never"/.test(value)));
  assert.throws(() => runtimeSettings('https://provider.example/v1'), /provider_scope/);
  assert.throws(() => runtimeSettings('http://127.0.0.1:12/v1?secret'), /provider_scope/);
});

test('exact native shlex commands are recognized without executing or general shell parsing', () => {
  const quote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  for (const [text, expected] of [['python3 -B /opt/fixture.py read', 'read'],
    ['python3 -B /opt/fixture.py test', 'test'], ["python3 -B /opt/fixture.py edit 'a + b'", 'edit']]) {
    assert.equal(commandKind(text), expected);
    assert.equal(commandKind(`/bin/bash -c ${quote(text)}`), expected);
    assert.equal(commandKind(`/usr/bin/bash -lc ${quote(text)}`), expected);
  }
  for (const text of ['cat /etc/passwd', 'python3 -B /opt/fixture.py test; id',
    'python3 -B /opt/fixture.py read\nid', '/bin/bash -c "python3 -B /opt/fixture.py test" extra',
    "python3 -B /opt/fixture.py edit 'a + b; import os'", "python3 -B /opt/fixture.py edit '$(id)'",
    'python3 -B /opt/other.py read', "python3 -B /opt/fixture.py edit 'a + b", null]) {
    assert.equal(commandKind(text), null);
  }
});

test('fixture approvals bind exact thread, turn, path and one command; no network or policy escalation', () => {
  const request = {kind: 'command', threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: PROJECT,
    command: '/bin/bash -c "python3 -B /opt/fixture.py read"'};
  assert(authorize(request, 'thread', 'turn'));
  for (const change of [{cwd: '/tmp'}, {kind: 'writeStdin'}, {threadId: 'foreign'}, {turnId: 'old'},
    {command: 'rm -rf /'}, {networkApprovalContext: {}}, {additionalPermissions: {}},
    {proposedExecpolicyAmendment: ['python3']}, {proposedNetworkPolicyAmendments: []}]) {
    assert.equal(authorize({...request, ...change}, 'thread', 'turn'), false);
  }
  assert.equal(authorize(request, 'thread', null), false);
});

test('namespace command exposes exact socket/runtime/source inputs, not the host workspace or user home', () => {
  python(String.raw`
import runpy
from pathlib import Path
s = runpy.run_path('scripts/smoke_native_coding.py')
c = s['command'](Path('/w/server'), Path('/w/node'), Path('/w/private/socket'), Path('/w/prompt'),
                 Path('/w/fixture'), '/home/fixture')
for flag in ('--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--clearenv'):
    assert flag in c
assert ['--ro-bind','/','/'] not in [c[i:i+3] for i in range(len(c)-2)]
assert ['--ro-bind','/w/private/socket','/opt/core/compute.sock'] in [c[i:i+3] for i in range(len(c)-2)]
assert not any(c[i:i+2] == ['--setenv',name] for i in range(len(c)-1)
               for name in ('HOME','CODEX_HOME','OPENAI_API_KEY'))
assert '--cap-drop' in c and c[c.index('--cap-drop')+1] == 'ALL'
assert c[c.index('--chdir')+1] == '/opt/work/project'
`);
});

test('runtime provenance binds binary, source, lock, exact compatibility patch and retained notices', () => {
  python(String.raw`
import runpy,tempfile,json,hashlib
from pathlib import Path
s=runpy.run_path('scripts/smoke_native_coding.py')
with tempfile.TemporaryDirectory() as d:
 root=Path(d); (root/'third_party').mkdir(); bundle=root/'bundle'; (bundle/'runtime').mkdir(parents=True)
 (bundle/'notices').mkdir(); binary=bundle/'runtime/codex-app-server'; binary.write_bytes(b'not executable - offline fixture')
 hashes={}
 for name in ('LICENSE','NOTICE'):
  data=('synthetic '+name).encode(); (bundle/'notices'/name).write_bytes(data)
  (bundle/'notices'/name).chmod(0o600); hashes[name]=hashlib.sha256(data).hexdigest()
 hashes['codex-rs/Cargo.lock']='a'*64
 pin=dict(revision=s['UPSTREAM'],tree='b'*40,sha256=hashes,patches=[{'file':'synthetic.patch','sha256':'c'*64}])
 (root/'third_party/codex-runtime.json').write_text(json.dumps(pin))
 sha=hashlib.sha256(binary.read_bytes()).hexdigest()
 report=dict(version=1,app_server_built=True,staged_source_verified=True,original_source_unchanged=True,
  source_revision=pin['revision'],source_tree=pin['tree'],lock_sha256=hashes['codex-rs/Cargo.lock'],local_patches=pin['patches'],
  binary=dict(path='runtime/codex-app-server',bytes=binary.stat().st_size,sha256=sha))
 p=bundle/'BUILD_REPORT.json'; p.write_text(json.dumps(report)); p.chmod(0o600)
 s['verified_build'].__globals__['ROOT']=root
 assert s['verified_build'](str(p),binary,sha)['source_revision']==s['UPSTREAM']
 for change in ({'local_patches':[]},{'app_server_built':False},{'source_revision':'f'*40}):
  p.write_text(json.dumps(report|change))
  try:s['verified_build'](str(p),binary,sha)
  except ValueError:pass
  else:raise AssertionError('unbound runtime accepted')
`);
});

test('synthetic helper really reads, applies supplied arithmetic, and runs failing then passing tests', () => {
  python(String.raw`
import importlib.util, tempfile, os, sys, contextlib, io, json
from pathlib import Path
spec = importlib.util.spec_from_file_location('fixture','scripts/native_coding_fixture.py')
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
for bad in ('__import__("os")', 'a ** 100000', '[a,b]', 'a; b', 'True', '101', 'secret'):
    try: f.expression(bad)
    except (ValueError,SyntaxError): pass
    else: raise AssertionError('unsafe arithmetic accepted')
with tempfile.TemporaryDirectory() as temporary:
    before = Path.cwd()
    f.PROJECT = Path(temporary); f.SOURCE = f.PROJECT/'arithmetic.py'
    f.SOURCE.write_text(f.ORIGINAL); os.chdir(f.PROJECT)
    def action(*args):
        sys.argv = ['fixture',*args]
        output=io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()): status=f.main()
        return status,json.loads(output.getvalue())
    try:
        assert action('read')[1]['source'] == f.ORIGINAL
        assert action('test')[0] == 1
        assert action('edit','a * b')[0] == 0
        assert 'return a * b' in f.SOURCE.read_text()
        assert action('test')[0] == 1
        assert action('edit','a + b')[0] == 0
        assert action('test') == (0,{'action':'test','passed':True,'tests':3})
        assert list(f.PROJECT.iterdir()) == [f.SOURCE]
    finally: os.chdir(before)
`);
});

test('native coding driver requires genuine app-server tools, core terminal cleanup and independent post-edit tests', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/smoke_native_coding.cjs'), 'utf8');
  for (const snippet of ['new AppServer(child.stdout, child.stdin', 'client.startTurn(threadId, TASK)',
    "params.item?.type === 'commandExecution'", 'item.exitCode === 0', 'authorize(params, threadId, turnId)',
    "spawnSync('/usr/bin/python3', ['-B', '/opt/fixture.py', 'test']", 'report.responses.completed >= 4',
    'report.responses.submitted === report.responses.cleanup_confirmed', 'thread/unsubscribe']) assert(source.includes(snippet));
  assert(!/console\.(log|error)|fake|mockResponse/.test(source));
  assert(source.includes('private_peer_execution_claimed: false, general_coding_quality_claimed: false'));
  assert(source.includes("kind === 'edit' && !report.read"));
});

test('closed receipt rejects invented success and arbitrary text fields', () => {
  python(String.raw`
import runpy,tempfile,json,hashlib
from pathlib import Path
s=runpy.run_path('scripts/smoke_native_coding.py')
v=dict(version=1,kind='native-codex-core-coding',success=False,phase='native-turn',model='qwen3-0.6b-v1',
 full_native_prompt_sha256=s['PROMPT_SHA256'],before_sha256=hashlib.sha256(s['ORIGINAL']).hexdigest(),after_sha256=None,
 native_turn_completed=False,read=False,edit=False,test=False,independent_test_passed=False,
 accepted_commands=0,declined_commands=0,unexpected_command=False,thread_unsubscribed=False,responses=None,
 private_peer_execution_claimed=False,general_coding_quality_claimed=False,runtime_exit=1,forced_stop=False,
 diagnostic='native_coding_incomplete')
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'receipt.json'; p.write_text(json.dumps(v)); assert s['closed_receipt'](p)==v
 for changes in ({'success':True},{'diagnostic':'raw private command'},{'full_native_prompt_sha256':'wrong'},
                 {'url':'https://private.invalid'},{'accepted_commands':999}):
  p.write_text(json.dumps(v|changes))
  try:s['closed_receipt'](p)
  except ValueError:pass
  else:raise AssertionError('unproven receipt accepted')
`);
  assert.match(PROMPT_SHA256, /^[a-f0-9]{64}$/);
});
