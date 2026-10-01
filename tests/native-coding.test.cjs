// SPDX-License-Identifier: GPL-3.0-only
// Offline policy/helper checks, not native model or coding-loop evidence.
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {MODEL, PROJECT, PROMPT_SHA256, modelCatalog, runtimeSettings, commandKind,
  APPROVAL_DENIALS, approvalDenial, authorize, TASK, CONTINUATION, ITEM_TYPES,
  NativeTaskController} = require('../src/native-coding-fixture.cjs');
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
  for (const [change, reason] of [[{cwd: '/tmp'}, 'cwd'], [{kind: 'writeStdin'}, 'kind'],
    [{threadId: 'foreign'}, 'lineage'], [{turnId: 'old'}, 'lineage'], [{itemId: null}, 'item'],
    [{itemId: 'x'.repeat(257)}, 'item'], [{command: 'rm -rf /'}, 'command'],
    [{networkApprovalContext: {}}, 'network'], [{additionalPermissions: {}}, 'permissions'],
    [{proposedNetworkPolicyAmendments: []}, 'network_policy']]) {
    assert.equal(authorize({...request, ...change}, 'thread', 'turn'), false);
    assert.equal(approvalDenial({...request, ...change}, 'thread', 'turn'), reason);
    assert(APPROVAL_DENIALS.includes(reason));
  }
  assert.equal(authorize(request, 'thread', null), false);
  assert.equal(approvalDenial(null, 'thread', 'turn'), 'lineage');
});

test('observed native read proposal is not a request to persist execution policy', () => {
  // Payload shape observed from exact native source 67727e7cf in isolated local
  // protocol reproduction, with synthetic Responses and every action declined.
  const request = {kind: 'command', threadId: 'thread', turnId: 'turn', itemId: 'synthetic_read_01',
    startedAtMs: 1790884427876, environmentId: 'local',
    command: "/bin/bash -c 'python3 -B /opt/fixture.py read'", cwd: PROJECT,
    commandActions: [{type: 'unknown', command: 'python3 -B /opt/fixture.py read'}],
    proposedExecpolicyAmendment: ['python3', '-B', '/opt/fixture.py', 'read'],
    availableDecisions: ['accept', {acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ['python3', '-B', '/opt/fixture.py', 'read']}}, 'cancel']};
  assert.equal(approvalDenial(request, 'thread', 'turn'), null);
  assert.equal(authorize(request, 'thread', 'turn'), true);
  // A proposed rule is never authority, even if it would cover another command.
  assert.equal(authorize({...request, command: 'python3 -B /opt/other.py read'}, 'thread', 'turn'), false);
  assert.equal(authorize({...request, additionalPermissions: {network: true}}, 'thread', 'turn'), false);
  assert.equal(authorize({...request, threadId: 'another-owner'}, 'thread', 'turn'), false);
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
  const controller = fs.readFileSync(path.join(root, 'src/native-coding-fixture.cjs'), 'utf8');
  for (const snippet of ['new AppServer(child.stdout, child.stdin', 'await controller.run()',
    "spawnSync('/usr/bin/python3', ['-B', '/opt/fixture.py', 'test']", 'report.responses.completed >= 4',
    'report.responses.submitted === report.responses.cleanup_confirmed', 'thread/unsubscribe']) assert(source.includes(snippet));
  assert(!/console\.(log|error)|fake|mockResponse/.test(source));
  assert(source.includes('private_peer_execution_claimed: false, general_coding_quality_claimed: false'));
  assert(controller.includes("kind === 'edit' && !report.read"));
  assert(controller.includes('item.exitCode === 0'));
  assert(source.includes('}, 2400000)'));
});

function lifecycle(scripts) {
  const report = {read: false, edit: false, test: false, unexpected_command: false,
    native_turn_completed: false, accepted_commands: 0, declined_commands: 0,
    approval_denials: Object.fromEntries(APPROVAL_DENIALS.map(key => [key, 0])),
    turns_started: 0, turns_completed: 0, item_types: Object.fromEntries(ITEM_TYPES.map(key => [key, 0]))};
  const client = new EventEmitter();
  const inputs = [], interrupts = [];
  const controller = new NativeTaskController(client, 'thread', report);
  client.interrupt = async (...args) => { interrupts.push(args); };
  const request = (turnId, kind) => ({kind: 'command', threadId: 'thread', turnId, itemId: 'synthetic',
    cwd: PROJECT, command: kind === 'edit' ? "python3 -B /opt/fixture.py edit 'a + b'" : `python3 -B /opt/fixture.py ${kind}`});
  client.startTurn = async (threadId, text) => {
    inputs.push(text); const id = `turn-${inputs.length}`;
    client.emit('notification', {method: 'turn/started', params: {threadId, turn: {id}}});
    const item = value => client.emit('notification', {method: 'item/completed', params: {threadId, turnId: id, item: value}});
    const action = kind => {
      const proposed = request(id, kind);
      const allowed = controller.approve(proposed);
      item({...proposed, type: 'commandExecution', status: allowed ? 'completed' : 'declined', exitCode: allowed ? 0 : null});
      return allowed;
    };
    const complete = (status = 'completed') => client.emit('notification', {
      method: 'turn/completed', params: {threadId, turn: {id, status}}});
    scripts[inputs.length - 1]({action, item, complete, request, id, controller, client});
    return {turn: {id}};
  };
  return {controller, report, inputs, interrupts};
}

test('actual controller accepts early started/completed notifications and stops after one complete task', async () => {
  const f = lifecycle([({action, item, complete}) => {
    action('read'); action('edit'); action('test'); item({type: 'agentMessage', text: 'PRIVATE_CANARY'}); complete();
  }]);
  try { await f.controller.run(); } finally { f.controller.dispose(); }
  assert.deepEqual(f.inputs, [TASK]);
  assert.equal(f.report.turns_started, 1); assert.equal(f.report.turns_completed, 1);
  assert.equal(f.report.item_types.commandExecution, 3); assert.equal(f.report.item_types.agentMessage, 1);
  assert(!JSON.stringify(f.report).includes('PRIVATE_CANARY'));
});

test('one normal incomplete task continues in the same thread without a suggested fix', async () => {
  const f = lifecycle([
    ({action, complete}) => { action('read'); complete(); },
    ({action, request, controller, complete}) => {
      assert.equal(controller.approve(request('turn-1', 'edit')), false);
      assert.equal(controller.report.approval_denials.lineage, 1);
      action('edit'); action('test'); complete();
    },
  ]);
  try { await f.controller.run(); } finally { f.controller.dispose(); }
  assert.deepEqual(f.inputs, [TASK, CONTINUATION]);
  assert(!/fixture.py|python|a\s*\+\s*b|exec_command/.test(CONTINUATION));
  assert.equal(f.report.turns_completed, 2); assert.equal(f.report.accepted_commands, 3);
});

test('two normally completed but unfinished turns never fabricate success or schedule a third', async () => {
  const f = lifecycle([({action, complete}) => { action('read'); complete(); },
    ({complete, controller, request, id}) => {
      complete();
      assert.equal(controller.approve(request(id, 'edit')), false, 'ended turn cannot grant late authority');
    }]);
  try { await assert.rejects(f.controller.run(), /native_task_incomplete/); } finally { f.controller.dispose(); }
  assert.equal(f.inputs.length, 2); assert.equal(f.report.edit, false); assert.equal(f.report.test, false);
  assert.equal(f.report.native_turn_completed, true);
});

test('failed or interrupted native turns and transport EOF never cause continuation', async () => {
  for (const state of ['failed', 'interrupted', 'eof']) {
    const f = lifecycle([({complete, client}) => state === 'eof' ? client.emit('closed') : complete(state)]);
    try { await assert.rejects(f.controller.run()); } finally { f.controller.dispose(); }
    assert.equal(f.inputs.length, 1); assert.equal(f.report.native_turn_completed, false);
  }
});

test('same approval budget spans both turns and revoked continuation performs no new turn', async () => {
  const f = lifecycle([
    ({action, complete}) => { for (let n = 0; n < 5; n++) action('read'); complete(); },
    ({action, complete}) => { assert(action('edit')); assert.equal(action('test'), false); complete(); },
  ]);
  try { await assert.rejects(f.controller.run(), /native_task_incomplete/); } finally { f.controller.dispose(); }
  assert.equal(f.report.accepted_commands, 6); assert.equal(f.report.approval_denials.budget, 1);
  const stopped = lifecycle([({controller}) => { void controller.stop(); }]);
  try { await assert.rejects(stopped.controller.run()); } finally { stopped.controller.dispose(); }
  assert.equal(stopped.inputs.length, 1); assert.deepEqual(stopped.interrupts, [['thread', 'turn-1']]);
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
 denials={reason:0 for reason in s['APPROVAL_DENIALS']}; denials['command']=1
 v2=v|dict(version=2,declined_commands=1,approval_denials=denials)
 p.write_text(json.dumps(v2)); assert s['closed_receipt'](p)==v2
 for changes in ({'version':3},{'version':True},{'version':1},{'declined_commands':0},
                 {'approval_denials':{}},{'approval_denials':denials|{'raw private command':1}},
                 {'approval_denials':denials|{'command':True}},
                 {'approval_denials':denials|{'command':-1}},
                 {'approval_denials':denials|{'command':17}},
                 {'approval_denials':denials|{'command':'private command'}}):
  p.write_text(json.dumps(v2|changes))
  try:s['closed_receipt'](p)
  except ValueError:pass
  else:raise AssertionError('invalid denial counters accepted')
 p.write_text(json.dumps({k:value for k,value in v2.items() if k!='approval_denials'}))
 try:s['closed_receipt'](p)
 except ValueError:pass
 else:raise AssertionError('v2 counters missing')
 v3=v2|dict(version=3,turns_started=2,turns_completed=2,
   item_types=dict(commandExecution=1,agentMessage=1,userMessage=2,reasoning=0,other=0),
   responses=dict(submitted=1,completed=1,incomplete=0,cleanup_confirmed=1),
   response_diagnostics=dict(version=1,truncated=False,records=[dict(output_kind='assistant',
    prompt_tokens=9000,generated_tokens=100,turn_complete=True,incomplete_reason=None,elapsed_ms=300000)]))
 p.write_text(json.dumps(v3)); assert s['closed_receipt'](p)==v3
 for change in ({'turns_started':3},{'turns_completed':True},{'response_diagnostics':None},
                {'item_types':v3['item_types']|{'private':'PRIVATE_CANARY'}}):
  p.write_text(json.dumps(v3|change))
  try:s['closed_receipt'](p)
  except ValueError:pass
  else:raise AssertionError('unbounded diagnostics accepted')
 for change in ({'output_kind':'PRIVATE_CANARY'},{'text':'PRIVATE_CANARY'},{'prompt_tokens':12289},
                {'generated_tokens':1025},{'elapsed_ms':3600001},{'turn_complete':1}):
  bad=v3|dict(response_diagnostics=v3['response_diagnostics']|dict(records=[v3['response_diagnostics']['records'][0]|change]))
  p.write_text(json.dumps(bad))
  try:s['closed_receipt'](p)
  except ValueError:pass
  else:raise AssertionError('private or unbounded diagnostic accepted')
`);
  assert.match(PROMPT_SHA256, /^[a-f0-9]{64}$/);
});
