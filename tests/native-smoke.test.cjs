// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');

test('native smoke uses private namespaces and never overrides Codex/user homes', () => {
  const check = String.raw`
import runpy
from pathlib import Path
s = runpy.run_path('scripts/smoke_app_server.py')
command = s['command'](Path('/fake/server'), Path('/fake/node'), Path('/fake/work'), '/home/fixture')
assert command[0] == '/usr/bin/bwrap'
for flag in ('--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--clearenv'):
    assert flag in command
for name in ('/home','/root','/run','/media','/mnt','/tmp','/opt','/etc'):
    assert any(command[i:i+2] == ['--tmpfs',name] for i in range(len(command)-1))
for name in ('HOME','CODEX_HOME','OPENAI_API_KEY'):
    assert not any(command[i:i+2] == ['--setenv',name] for i in range(len(command)-1))
assert command[-2] == '--inside'
assert '--cap-drop' in command and command[command.index('--cap-drop')+1] == 'ALL'
`;
  const result = spawnSync('python3', ['-B', '-c', check], {cwd: root, encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, result.stderr);
});

test('native probe cannot replace model inference with a test answer', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/smoke_app_server.cjs'), 'utf8');
  assert.match(source, /new AppServer\(child.stdout, child.stdin/);
  assert.match(source, /client.initialize\(\)/);
  assert.match(source, /client.startThread\(/);
  assert.match(source, /thread\/unsubscribe/);
  assert.match(source, /assert.equal\(unsubscribed.status, 'unsubscribed'\)/);
  assert.doesNotMatch(source, /stdout_protocol_only/);
  assert.doesNotMatch(source, /client.startTurn\(|turn\/start/);
  assert.match(source, /requires_openai_auth=false/);
  assert.match(source, /inference_proven: false, tools_proven: false, core_model_connection_proven: false/);
  assert.match(source, /fs.writeFileSync\('\/opt\/work\/receipt.json'/);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
});
