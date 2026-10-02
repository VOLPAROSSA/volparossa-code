#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""One explicit OpenCode/Qwen guest trial; no host model execution or installation.

pack captures the dirty Code candidate by exact file hash (never as a clean Git
revision). execute owns one six-GiB KVM, its private SSH keys and its teardown.
guest is rejected outside the disposable vpci Debian KVM. No Codex is launched.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CORE = '708bcdd2960ae019579b1c4ce6991ed57653050c'
MODEL = 'qwen3-0.6b-v1'
GIB = 1024 ** 3
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
IMAGE_NAME = 'debian-13-genericcloud-amd64-20260826-2582.qcow2'
IMAGE_SHA512 = '184761b0dad0f9ace02f9298050ca96ce3caa39a461a47706d47ff9698b59933918b91b40177fbd4d392f6446af8b4d18ecb94caca988169b19641606bf34003'
BASE = Path('/home/vpci/opencode-trial')
INPUT = Path('/home/vpci/opencode-input')
SOURCE = Path('/home/vpci/source')
PROJECTS = Path('/home/vpci/opencode-projects')
CORE_UNIT = 'volparossa-opencode-core.service'
TASK_UNIT = 'volparossa-opencode-task.service'


def require(value, reason):
    if not value:
        raise ValueError(reason)


def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def run(argv, **kwargs):
    return subprocess.run([str(arg) for arg in argv], check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 60), **kwargs)


def record(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
    path.chmod(0o600)


def load(path, maximum=2 * 1024**2):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, 'report_bound')
    return json.loads(path.read_bytes())


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def canonical(path):
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical_input')
    return path


def new_output(path):
    require(path.is_absolute() and path.resolve() == path and not path.exists()
            and not path.is_symlink() and path.parent.is_dir()
            and path.is_relative_to(ROOT / 'build'), 'new_workspace_output')


def pack(args):
    new_output(args.output)
    canonical(args.core)
    require(run(['git', '-C', args.core, 'rev-parse', 'HEAD'], text=True).stdout.strip() == CORE, 'exact_core')
    report_path = ROOT / 'build/opencode-runtime/build-report.json'
    report = load(report_path, 65536)
    binary = canonical(Path(report['binary']))
    require(report['source_build'] is True and report['source_commit'] == 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
            and digest(binary) == report['binary_sha256'] and report['runtime_version'] == '1.18.34', 'exact_opencode')
    private = module(args.core / 'tests/integration/agent-private-conversation.py', 'opencode_private_inputs')
    node_pin = private.pins()['runtime']['files']['bin/node']
    canonical(args.node)
    require(args.node.stat().st_size == node_pin['bytes'] and digest(args.node) == node_pin['sha256'], 'exact_node')
    files = {f'code/{path.relative_to(ROOT)}': path for path in sorted((ROOT / 'src').glob('*.cjs'))}
    names = ['src/opencode-cooperative-tool.js', 'scripts/opencode_session.py', 'scripts/opencode_session.cjs',
             'scripts/smoke_opencode_inference.cjs', 'scripts/smoke_opencode_inference.py',
             'third_party/opencode.json', 'third_party/opencode-LICENSE.txt',
             'third_party/opencode-build-tools.json', 'patches/opencode-no-runtime-installs.patch',
             'LICENSE', 'THIRD_PARTY_LICENSES.md']
    files.update({f'code/{name}': ROOT / name for name in names})
    files.update({'runtime/opencode': binary, 'runtime/build-report.json': report_path,
                  'runtime/node': args.node, 'runtime/node-LICENSE': args.node.parent.parent / 'LICENSE'})
    require(len(files) < 128, 'source_bound')
    inventory = {}
    with tempfile.TemporaryDirectory(prefix='opencode-pack-', dir=args.output.parent) as temp:
        archive = Path(temp) / 'core.tar'
        with archive.open('xb') as stream:
            subprocess.run(['git', '-C', str(args.core), 'archive', '--format=tar', CORE],
                           stdout=stream, stderr=subprocess.PIPE, timeout=60, check=True)
        files['core.tar'] = archive
        for name, source in files.items():
            info = canonical(source).lstat()
            require(stat.S_ISREG(info.st_mode) and 0 < info.st_size < 200 * 1024**2, 'source_file')
            inventory[name] = {'bytes': info.st_size, 'sha256': digest(source),
                               'mode': 0o700 if name in ('runtime/opencode', 'runtime/node') else 0o600}
        manifest = dict(version=1, kind='opencode-inference-inputs', core_revision=CORE,
            code_base_revision=run(['git', '-C', ROOT, 'rev-parse', 'HEAD'], text=True).stdout.strip(),
            code_contains_uncommitted_changes=True, code_git_head_proves_migration=False,
            node_version='24.19.0', model_profile=MODEL, opencode_revision=report['source_commit'],
            opencode_binary_sha256=report['binary_sha256'], files=inventory)
        encoded = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        with tarfile.open(args.output, 'x:gz', compresslevel=1) as target:
            for name, source in files.items():
                row = inventory[name]
                require(digest(source) == row['sha256'], 'capture_changed')
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = row['bytes'], row['mode']
                with source.open('rb') as stream:
                    target.addfile(entry, stream)
            entry = tarfile.TarInfo('INPUTS.json')
            entry.size, entry.mode = len(encoded), 0o600
            target.addfile(entry, io.BytesIO(encoded))
        args.output.chmod(0o600)
    print(json.dumps({'packed': True, 'sha256': digest(args.output), 'bytes': args.output.stat().st_size,
                      'manifest_sha256': hashlib.sha256(encoded).hexdigest(), 'files': len(inventory),
                      'core_revision': CORE, 'code_contains_uncommitted_changes': True}))


def staged_inputs():
    manifest = load(INPUT / 'INPUTS.json')
    require(manifest['core_revision'] == CORE and manifest['model_profile'] == MODEL
            and manifest['code_contains_uncommitted_changes'] is True
            and manifest['code_git_head_proves_migration'] is False, 'input_authority')
    for name, row in manifest['files'].items():
        parts = PurePosixPath(name)
        require(not parts.is_absolute() and '..' not in parts.parts and str(parts) == name, 'input_name')
        source = canonical(INPUT / name)
        info = source.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == row['mode'] and info.st_size == row['bytes']
                and digest(source) == row['sha256'], 'input_identity')
    return manifest


def unit(name, *args, check=True):
    require(name in (CORE_UNIT, TASK_UNIT), 'unit_scope')
    return subprocess.run(['sudo', '-n', 'systemctl', *args, name], capture_output=True,
                          text=True, timeout=20, check=check)


def properties(name):
    result = unit(name, 'show', '--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus', check=False)
    require(len(result.stdout) < 8192, 'unit_properties')
    return dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)


def cgroup(name):
    require(name in (CORE_UNIT, TASK_UNIT), 'cgroup_scope')
    return Path('/sys/fs/cgroup/system.slice') / name


def empty(name):
    group = cgroup(name)
    return not group.exists() or all(not p.read_text().strip() for p in group.rglob('cgroup.procs'))


def memory(name):
    group = cgroup(name)
    events = dict(row.split() for row in (group / 'memory.events').read_text().splitlines())
    return {**{key: int((group / field).read_text()) for key, field in
        [('maximum', 'memory.max'), ('swap', 'memory.swap.max'), ('peak', 'memory.peak')]},
        'oom_kill': int(events['oom_kill'])}


def start(name, command, limit, seconds):
    (BASE / (name + '.log')).touch(mode=0o600)
    run(['sudo', '-n', 'systemd-run', '--quiet', '--unit=' + name, '--property=Type=exec',
         '--property=RemainAfterExit=yes', '--property=User=vpci', '--property=Group=vpci',
         '--property=WorkingDirectory=/home/vpci/source', '--property=MemoryMax=' + str(limit),
         '--property=MemorySwapMax=0', '--property=TasksMax=256', '--property=KillMode=control-group',
         '--property=RuntimeMaxSec=' + str(seconds), '--property=TimeoutStopSec=15',
         '--property=NoNewPrivileges=yes', '--property=PrivateNetwork=yes',
         '--property=StandardOutput=append:' + str(BASE / (name + '.log')),
         '--property=StandardError=append:' + str(BASE / (name + '.log')),
         '--setenv=RUST_LOG=off,volparossa::compute::private_diagnostic=debug', '--setenv=NO_COLOR=1', *command])


def guest(args):
    os.umask(0o077)
    require(os.getuid() > 0 and pwd.getpwuid(os.getuid()).pw_name == 'vpci'
            and socket.gethostname() == 'volparossa-alpha'
            and run(['systemd-detect-virt', '--vm'], text=True).stdout.strip() == 'kvm'
            and 'VERSION_ID="13"' in Path('/etc/os-release').read_text(), 'disposable_guest_required')
    require(not BASE.exists() and not PROJECTS.exists() and not SOURCE.exists(), 'fresh_guest')
    manifest = staged_inputs()
    output = Path('/home/vpci/opencode-result.json')
    require(not output.exists(), 'fresh_receipt')
    BASE.mkdir(mode=0o700)
    PROJECTS.mkdir(mode=0o700)
    SOURCE.mkdir(mode=0o700)
    # Core archive is the exact git archive independently bound by INPUTS.json.
    with tarfile.open(INPUT / 'core.tar') as source:
        source.extractall(SOURCE, filter='data')
    private = module(SOURCE / 'tests/integration/agent-private-conversation.py', 'opencode_private')
    train = private.TRAIN
    before, provision, created = None, None, []
    report = dict(version=1, kind='opencode-real-inference-guest', passed=False, phase='packages',
        failure=None, core_revision=CORE, input_manifest_sha256=digest(INPUT / 'INPUTS.json'),
        code_contains_uncommitted_changes=True, model_profile=MODEL, actual_model_provisioned=False,
        private_peer_execution_proven=False, confidential_remote_execution_proven=False,
        raw_model_output_exported=False, host_state_unchanged=None, units_empty=False, private_data_removed=False)
    try:
        for name in (CORE_UNIT, TASK_UNIT):
            require(properties(name).get('LoadState') == 'not-found', 'existing_unit')
        for argv in (['apt-get', 'update'], ['apt-get', 'install', '--yes', '--no-install-recommends',
            'build-essential', 'ca-certificates', 'cargo', 'cmake', 'git', 'iproute2', 'nftables',
            'pkg-config', 'python3-venv', 'rustc', 'bubblewrap', 'util-linux', 'libssl3t64']):
            with (BASE / 'packages.log').open('ab') as log:
                subprocess.run(['sudo', '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', *argv],
                               stdout=log, stderr=log, check=True, timeout=600)
        before = train['snapshot']()
        report['phase'] = 'core-build'
        build_env = dict(ENV, CARGO_TARGET_DIR='/home/vpci/target', CARGO_BUILD_JOBS='2',
                         CARGO_PROFILE_DEV_DEBUG='0', CARGO_INCREMENTAL='0')
        with (BASE / 'core-build.log').open('xb') as log:
            subprocess.run(['/usr/bin/cargo', 'build', '--locked', '-p', 'volparossa', '--bin', 'volparossa'],
                           cwd=SOURCE, env=build_env, stdout=log, stderr=log, timeout=1200, check=True)
        report['core_binary_sha256'] = digest(private.CLI)
        report['phase'] = 'model-provision'
        with (BASE / 'provision.log').open('xb') as log:
            provision = subprocess.Popen([sys.executable, '-B', str(private.ML / 'provision.py'),
                '--execute', '--yes', '--disposable-guest', '--model-profile', MODEL,
                '--root', str(BASE / 'ml'), '--budget-bytes', str(5 * GIB)],
                stdout=log, stderr=log, start_new_session=True, env=ENV)
            require(provision.wait(timeout=1850) == 0, 'provision_failed')
        observed = load(BASE / 'ml/provision-report.json')
        model = module(private.ML / 'provision.py', 'opencode_model_provision')
        pins = model.load_pins(MODEL)
        retained, lock = model.retained_pin_files(pins)
        expected = dict(model_id=pins['model_id'], revision=pins['revision'], model_profile=MODEL,
            download_bytes=model.download_total(pins), budget_bytes=5 * GIB, installed_wheels=len(pins['wheels']),
            model_pins_sha256=hashlib.sha256(retained).hexdigest(), requirements_sha256=hashlib.sha256(lock).hexdigest())
        require(observed['success'] is True and observed['training_performed'] is False
                and observed['runtime_autofetch_enabled'] is False
                and {key: observed[key] for key in expected} == expected, 'model_provenance')
        report['actual_model_provisioned'], report['model_provision'] = True, expected
        report['phase'] = 'core-start'
        (BASE / 'work').mkdir(mode=0o700)
        created.append(CORE_UNIT)
        start(CORE_UNIT, [str(private.CLI), 'compute', 'private-serve', '--socket', str(BASE / 'private.sock'),
            '--work-parent', str(BASE / 'work'), '--runtime-root', str(BASE / 'ml/venv'),
            '--model-root', str(BASE / 'ml/model'), '--model-profile', MODEL,
            '--threads', '2', '--max-seconds', '600', '--execute'], 5 * GIB, 2700)
        deadline = time.monotonic() + 15
        while not (BASE / 'private.sock').exists() and time.monotonic() < deadline:
            time.sleep(.1)
        state = properties(CORE_UNIT)
        require(state.get('ActiveState') == 'active' and (BASE / 'private.sock').is_socket(), 'core_not_ready')
        require(int(state['MainPID']) > 0, 'core_process')
        report['phase'] = 'opencode-task'
        created.append(TASK_UNIT)
        start(TASK_UNIT, [str(INPUT / 'runtime/node'), str(INPUT / 'code/scripts/smoke_opencode_inference.cjs'),
            '--execute', '--yes', '--node', str(INPUT / 'runtime/node'), '--build-report',
            str(INPUT / 'runtime/build-report.json'), '--socket', str(BASE / 'private.sock'),
            '--project-parent', str(PROJECTS), '--output', str(BASE / 'task.json')], 768 * 1024**2, 2550)
        deadline = time.monotonic() + 2565
        while time.monotonic() < deadline:
            state = properties(TASK_UNIT)
            if state.get('SubState') == 'exited' or state.get('ActiveState') in ('failed', 'inactive'):
                break
            time.sleep(2)
        report['task_unit_result'] = state.get('Result') if state.get('Result') in (
            'success', 'exit-code', 'signal', 'timeout', 'oom-kill', 'resources') else 'other'
        report['task_exit_status'] = int(state.get('ExecMainStatus', '-1'))
        if (BASE / 'task.json').exists():
            report['task'] = load(BASE / 'task.json', 32768)
        for name, field in ((CORE_UNIT, 'core_memory'), (TASK_UNIT, 'task_memory')):
            report[field] = memory(name)
            require(report[field]['swap'] == report[field]['oom_kill'] == 0, 'resource_violation')
        report['core_diagnostics'] = private.service_diagnostic(BASE / (CORE_UNIT + '.log'))
        require(report['task_exit_status'] == 0 and report.get('task', {}).get('passed') is True, 'task_failed')
        require(empty(TASK_UNIT) and not list((BASE / 'work').iterdir()), 'task_private_cleanup')
        require(staged_inputs() == manifest, 'staged_inputs_changed')
        report['inputs_unchanged'] = True
        report['phase'] = 'core-stop'
        unit(CORE_UNIT, 'kill', '--kill-whom=main', '--signal=SIGINT')
        for _ in range(100):
            state = properties(CORE_UNIT)
            if state.get('MainPID') == '0':
                break
            time.sleep(.1)
        require(state.get('SubState') == 'exited' and state.get('Result') == 'success'
                and state.get('ExecMainStatus') == '0' and empty(CORE_UNIT)
                and not (BASE / 'private.sock').exists(), 'core_clean_stop')
        report['core_clean_stop'] = True
        report['phase'] = 'complete'
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        report['failure'] = 'stage_failed'
    finally:
        report['provision_group_joined'] = private.stop_client(provision)
        # The original worker monitor owns descendants; stopping the complete
        # cgroup joins nested native/model processes, not just their leaders.
        for name in reversed(created):
            if cgroup(name).exists():
                try:
                    report['core_memory' if name == CORE_UNIT else 'task_memory'] = memory(name)
                except (OSError, ValueError, KeyError):
                    report['failure'] = 'resource_observation_failed'
            unit(name, 'stop', check=False)
        if (BASE / (CORE_UNIT + '.log')).exists():
            try:
                report['core_diagnostics'] = private.service_diagnostic(BASE / (CORE_UNIT + '.log'))
            except (OSError, ValueError, KeyError):
                report['failure'] = 'closed_diagnostic_failed'
        report['units_empty'] = all(empty(name) for name in created)
        if before is not None:
            after = train['snapshot']()
            report['host_state_unchanged'] = before == after
        if report['units_empty'] and report['provision_group_joined']:
            shutil.rmtree(BASE)
            shutil.rmtree(PROJECTS)
            report['private_data_removed'] = not BASE.exists() and not PROJECTS.exists()
        report['passed'] = report['phase'] == 'complete' and report['failure'] is None \
            and report['units_empty'] and report['provision_group_joined'] \
            and report['private_data_removed'] and report['host_state_unchanged'] is True
        record(output, report)
    return 0 if report['passed'] else 1


def host_state():
    # Unprivileged exact observable state; this runner never invokes host nft,
    # ip mutation, sysctl or DNS configuration commands.
    return {name: digest(Path(name)) for name in (
        '/proc/net/route', '/proc/net/ipv6_route', '/etc/resolv.conf')}


def available_memory():
    values = dict(row.split(':', 1) for row in Path('/proc/meminfo').read_text().splitlines())
    return int(values['MemAvailable'].split()[0]) * 1024


def closed_exception(error):
    classes = {'OSError', 'PermissionError', 'FileNotFoundError', 'ValueError', 'KeyError', 'TypeError',
               'InterruptedError', 'CalledProcessError', 'TimeoutExpired'}
    reason = error.args[0] if error.args and type(error.args[0]) is str else None
    reasons = {'host_available_memory_below_8GiB', 'another_vm_is_running', 'qemu_start', 'qemu_cgroup',
               'qemu_resource_limits', 'qemu_exited', 'guest_boot_deadline', 'guest_bundle_hash',
               'guest_trial_failed', 'user_unit_observation'}
    return {'class': type(error).__name__ if type(error).__name__ in classes else 'other',
            'reason': reason if reason in reasons else 'unclassified',
            'subprocess_status': error.returncode if isinstance(error, subprocess.CalledProcessError) else None}


def closed_qemu(state, stderr):
    """Fixed metadata only; neither paths nor raw stderr are an exported diagnostic."""
    classifications = [
        ('missing_library', (b'error while loading shared libraries',)),
        ('missing_firmware', (b'could not load PC BIOS', b'could not find ROM image', b'Could not open option rom')),
        ('missing_module', (b'failed to initialize module', b'failed to load module')),
        ('kvm_unavailable', (b'Could not access KVM', b'failed to initialize kvm', b'KVM is not supported')),
        ('port_in_use', (b'Could not set up host forwarding rule', b'Address already in use')),
        ('memory_allocation', (b'Cannot allocate memory', b'cannot set up guest memory')),
        ('disk_open', (b'Could not open backing file', b'Could not open ', b'Failed to get "write" lock')),
        ('sandbox', (b'failed to install seccomp', b'failed to create seccomp', b'Seccomp')),
        ('missing_file', (b'No such file or directory',)),
        ('permission_denied', (b'Permission denied',)),
    ]
    category = next((name for name, needles in classifications if any(word in stderr for word in needles)),
                    'empty' if not stderr else 'other')
    code, status = state.get('ExecMainCode', ''), state.get('ExecMainStatus', '')
    number = int(status) if re.fullmatch('[0-9]{1,3}', status) else None
    return {'active': state.get('ActiveState') if state.get('ActiveState') in ('active', 'inactive', 'failed', 'activating', 'deactivating') else 'unknown',
            'result': state.get('Result') if state.get('Result') in ('success', 'exit-code', 'signal', 'core-dump', 'oom-kill', 'timeout', 'resources') else 'unknown',
            'exit_code': number if code == '1' else None, 'signal': number if code in ('2', '3') else None,
            'stderr_class': category, 'stderr_bytes_observed': len(stderr), 'stderr_truncated': len(stderr) > 65536}


def boot_running(state):
    return state.get('ActiveState') == 'active' and str(state.get('MainPID', '')).isdigit() \
        and int(state['MainPID']) > 0


def qemu_command(tools, scratch):
    return [tools / 'bin/qemu-system-x86_64', '-name', 'volparossa-opencode-inference', '-no-user-config', '-nodefaults',
        '-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '2', '-m', '6144',
        '-device', 'VGA,id=video0,bus=pcie.0,addr=0x1,romfile=' + str(tools / 'root/usr/share/seabios/vgabios-stdvga.bin'),
        '-drive', 'if=virtio,format=qcow2,file=' + str(scratch / 'overlay.qcow2'),
        '-drive', 'if=virtio,format=raw,readonly=on,file=' + str(scratch / 'seed.img'),
        '-device', 'virtio-rng-pci', '-device', 'virtio-net-pci,netdev=net0',
        '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:22223-:22', '-display', 'none', '-monitor', 'none',
        '-serial', 'file:' + str(scratch / 'console.log'), '-no-reboot',
        '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny']


def validate_bundle(path):
    canonical(path)
    require(path.stat().st_size < 512 * 1024**2, 'bundle_bound')
    with tarfile.open(path) as archive:
        rows = archive.getmembers()
        require(len(rows) <= 128 and all(row.isfile() for row in rows), 'bundle_files')
        names = [row.name for row in rows]
        require(len(names) == len(set(names)) and names.count('INPUTS.json') == 1, 'bundle_names')
        for name in names:
            parts = PurePosixPath(name)
            require(not parts.is_absolute() and '..' not in parts.parts and str(parts) == name, 'bundle_path')
        manifest_entry = archive.getmember('INPUTS.json')
        require(manifest_entry.size <= 2 * 1024**2, 'manifest_bound')
        manifest = json.load(archive.extractfile(manifest_entry))
        require(manifest['core_revision'] == CORE and manifest['model_profile'] == MODEL
                and manifest['code_contains_uncommitted_changes'] is True
                and manifest['code_git_head_proves_migration'] is False
                and set(manifest['files']) == set(names) - {'INPUTS.json'}, 'bundle_authority')
        for name, pin in manifest['files'].items():
            row = archive.getmember(name)
            require(row.size == pin['bytes'] and row.mode == pin['mode']
                    and row.size <= 200 * 1024**2, 'bundle_file')
            with archive.extractfile(row) as stream:
                require(hashlib.file_digest(stream, 'sha256').hexdigest() == pin['sha256'], 'bundle_hash')
    return manifest


def execute(args):
    os.umask(0o077)
    require(args.yes and os.getuid() > 0, 'explicit_unprivileged_execution')
    new_output(args.output)
    require(available_memory() >= 8 * GIB, 'host_available_memory_below_8GiB')
    require(os.access('/dev/kvm', os.R_OK | os.W_OK), 'host_kvm_unavailable')
    canonical(args.image)
    require(args.image.name == IMAGE_NAME and digest(args.image, 'sha512') == IMAGE_SHA512, 'image_pin')
    canonical(args.core)
    require(run(['git', '-C', args.core, 'rev-parse', 'HEAD'], text=True).stdout.strip() == CORE, 'core_revision')
    run([sys.executable, '-B', args.core / 'tests/integration/browser-native-tools.py',
         '--verify', '--output', canonical(args.tools)])
    manifest = validate_bundle(args.bundle)
    # The host executes only this reviewed runner; guest code remains in KVM.
    require(manifest['files']['code/scripts/smoke_opencode_inference.py']['sha256'] == digest(Path(__file__)),
            'runner_differs_from_captured_input')
    listener = socket.socket()
    try:
        listener.bind(('127.0.0.1', 22223))
    finally:
        listener.close()
    for path in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            words = path.read_bytes().split(b'\0')
        except (OSError, PermissionError):
            continue
        require(not any(word.endswith(b'/qemu-system-x86_64') or word == b'qemu-system-x86_64' for word in words),
                'another_vm_is_running')
    args.output.mkdir(mode=0o700)
    before = host_state()
    record(args.output / 'host-state-before.json', before)
    scratch = Path(tempfile.mkdtemp(prefix='opencode-kvm-', dir=args.output.parent))
    os.chmod(scratch, 0o700)
    name = 'volparossa-opencode-vm-' + uuid.uuid4().hex[:12] + '.service'
    launched, status = False, 1
    receipt = dict(version=1, kind='opencode-inference-vm', passed=False, phase='prepare', failure=None,
        core_revision=CORE, bundle_sha256=digest(args.bundle), bundle_bytes=args.bundle.stat().st_size,
        code_contains_uncommitted_changes=True, memory_mib=6144, cpus=2, vm_started=False,
        qemu_joined=False, scratch_removed=False, host_observed_routes_dns_unchanged=None,
        host_firewall_modified=False, actual_model_execution_proven=False,
        confidential_remote_execution_proven=False)
    control = ['systemctl', '--user']
    key, hostkey, known = scratch / 'ssh-key', scratch / 'host-key', scratch / 'known-hosts'
    ssh_options = ['-F', '/dev/null', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ForwardAgent=no', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'IdentitiesOnly=yes',
        '-o', 'IdentityAgent=none', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PasswordAuthentication=no',
        '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'RequestTTY=no',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'Tunnel=no', '-o', 'UserKnownHostsFile=' + str(known)]

    def ssh(*command, timeout=30, check=True):
        return subprocess.run(['ssh', *ssh_options, '-p', '22223', 'vpci@127.0.0.1', *command],
                              capture_output=True, timeout=timeout, check=check)

    def scp(source, destination):
        run(['scp', *ssh_options, '-P', '22223', source, destination], timeout=600)

    def unit_state():
        result = subprocess.run([*control, 'show', name,
                                 '--property=ActiveState,MainPID,ControlGroup,Result,ExecMainCode,ExecMainStatus'],
                                text=True, capture_output=True, timeout=15)
        require(result.returncode in (0, 1), 'user_unit_observation')
        return dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)

    def interrupted(*_):
        raise InterruptedError('interrupted')

    old_signals = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        bins = args.tools / 'bin'
        run([bins / 'qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', args.image,
             scratch / 'overlay.qcow2', '18G'])
        for target, label in ((key, 'volparossa-opencode-user'), (hostkey, 'volparossa-opencode-host')):
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', label, '-f', target])
        known.write_text('[127.0.0.1]:22223 ' + hostkey.with_suffix('.pub').read_text())
        known.chmod(0o600)
        user = '#cloud-config\nusers:\n  - name: vpci\n    groups: [sudo]\n    sudo: "ALL=(ALL) NOPASSWD:ALL"\n'
        user += '    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ' + key.with_suffix('.pub').read_text()
        user += 'ssh_pwauth: false\ndisable_root: true\nssh_deletekeys: true\nssh_keys:\n  ed25519_private: |\n'
        user += ''.join('    ' + line + '\n' for line in hostkey.read_text().splitlines())
        user += '  ed25519_public: ' + hostkey.with_suffix('.pub').read_text()
        user += 'growpart:\n  mode: auto\n  devices: [/]\nresize_rootfs: true\n'
        (scratch / 'user-data').write_text(user)
        (scratch / 'meta-data').write_text('instance-id: ' + name + '\nlocal-hostname: volparossa-alpha\n')
        tool_env = dict(os.environ, PATH=str(bins) + ':' + os.environ['PATH'])
        run([bins / 'cloud-localds', scratch / 'seed.img', scratch / 'user-data', scratch / 'meta-data'], env=tool_env)
        # Check again immediately before launch; never rely on an earlier snapshot.
        available = available_memory()
        require(available >= 8 * GIB, 'host_available_memory_below_8GiB')
        receipt['host_available_bytes_at_launch'] = available
        qemu = qemu_command(args.tools, scratch)
        run(['systemd-run', '--user', '--quiet', '--unit=' + name, '--property=Type=exec',
            '--property=RemainAfterExit=yes',
            '--property=MemoryMax=' + str(7 * GIB), '--property=MemorySwapMax=0',
            '--property=RuntimeMaxSec=7200', '--property=TimeoutStopSec=15', '--property=KillMode=control-group',
            '--property=StandardOutput=null', '--property=StandardError=append:' + str(scratch / 'qemu.stderr'), *qemu], env=tool_env)
        launched, receipt['vm_started'], receipt['phase'] = True, True, 'guest-boot'
        state = unit_state()
        require(boot_running(state), 'qemu_start')
        receipt['qemu_pid'] = int(state['MainPID'])
        receipt['owned_unit'] = name
        group = state['ControlGroup']
        require(group.startswith('/user.slice/') and group.endswith('/' + name) and '..' not in group.split('/'),
                'qemu_cgroup')
        group_path = Path('/sys/fs/cgroup' + group)
        receipt['qemu_memory_max'] = int((group_path / 'memory.max').read_text())
        receipt['qemu_swap_max'] = int((group_path / 'memory.swap.max').read_text())
        require(receipt['qemu_memory_max'] == 7 * GIB and receipt['qemu_swap_max'] == 0, 'qemu_resource_limits')
        print(json.dumps({'phase': 'guest-boot', 'qemu_pid': receipt['qemu_pid'], 'unit': name}), flush=True)
        for _ in range(180):
            if ssh('true', timeout=10, check=False).returncode == 0:
                break
            require(boot_running(unit_state()), 'qemu_exited')
            time.sleep(1)
        else:
            raise ValueError('guest_boot_deadline')
        ssh('sudo', '-n', 'cloud-init', 'status', '--wait', timeout=120)
        receipt['phase'] = 'guest-stage'
        scp(args.bundle, 'vpci@127.0.0.1:/home/vpci/opencode-inputs.tar.gz')
        ssh('test', '!', '-e', str(INPUT))
        ssh('mkdir', '-m', '0700', str(INPUT))
        # Archive was completely verified locally; verify its bytes in the guest
        # before controlled extraction. Only regular relative entries are present.
        actual = ssh('sha256sum', '/home/vpci/opencode-inputs.tar.gz').stdout.decode().split()[0]
        require(actual == receipt['bundle_sha256'], 'guest_bundle_hash')
        ssh('tar', '-xzf', '/home/vpci/opencode-inputs.tar.gz', '-C', str(INPUT), '--no-same-owner')
        receipt['phase'] = 'guest-inference'
        print(json.dumps({'phase': receipt['phase'], 'model_profile': MODEL}), flush=True)
        executed = ssh('python3', '-B', str(INPUT / 'code/scripts/smoke_opencode_inference.py'), 'guest', timeout=6600, check=False)
        receipt['guest_exit_status'] = executed.returncode
        scp('vpci@127.0.0.1:/home/vpci/opencode-result.json', args.output / 'guest-result.json')
        result = load(args.output / 'guest-result.json', 65536)
        receipt['actual_model_execution_proven'] = bool(result.get('passed') and result.get('actual_model_provisioned'))
        require(executed.returncode == 0 and result.get('passed') is True, 'guest_trial_failed')
        receipt['phase'], status = 'complete', 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        receipt['failure'] = 'stage_failed'
        receipt['exception'] = closed_exception(error)
    finally:
        for sig, previous in old_signals.items():
            signal.signal(sig, previous)
        if launched:
            try:
                with (scratch / 'qemu.stderr').open('rb') as stream:
                    raw = stream.read(65537)
                receipt['qemu_before_cleanup'] = closed_qemu(unit_state(), raw)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                receipt['qemu_diagnostic_unavailable'] = True
            try:
                ssh('sudo', '-n', 'systemctl', 'poweroff', timeout=15, check=False)
            except (OSError, subprocess.SubprocessError):
                pass
            subprocess.run([*control, 'stop', name], capture_output=True, timeout=30, check=False)
            final = unit_state()
            receipt['qemu_joined'] = final.get('ActiveState') in ('inactive', 'failed') and final.get('MainPID') == '0'
        else:
            receipt['qemu_joined'] = True
        after = host_state()
        record(args.output / 'host-state-after.json', after)
        receipt['host_observed_routes_dns_unchanged'] = before == after
        if receipt['qemu_joined']:
            shutil.rmtree(scratch)
            receipt['scratch_removed'] = not scratch.exists()
        receipt['passed'] = status == 0 and receipt['qemu_joined'] and receipt['scratch_removed'] \
            and receipt['host_observed_routes_dns_unchanged'] is True
        record(args.output / 'vm-result.json', receipt)
        if launched and receipt['qemu_joined']:
            subprocess.run([*control, 'reset-failed', name], capture_output=True, timeout=15, check=False)
        print(json.dumps({'phase': receipt['phase'], 'passed': receipt['passed'], 'failure': receipt['failure'],
                          'qemu_joined': receipt['qemu_joined'], 'scratch_removed': receipt['scratch_removed']}), flush=True)
    return 0 if receipt['passed'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode')
    packing = modes.add_parser('pack')
    packing.add_argument('--core', type=Path, required=True)
    packing.add_argument('--node', type=Path, required=True)
    packing.add_argument('--output', type=Path, required=True)
    modes.add_parser('guest')
    execution = modes.add_parser('execute')
    execution.add_argument('--yes', action='store_true')
    for name in ('core', 'tools', 'image', 'bundle', 'output'):
        execution.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'pack':
        pack(args)
    elif args.mode == 'guest':
        return guest(args)
    elif args.mode == 'execute':
        return execute(args)
    else:
        print(json.dumps({'execute': False, 'plan': 'one6GiB2vCPUdisposableKVM; pinnedQweninsideguestonly',
                          'host_install': False, 'host_model_execution': False, 'actual_inference': False}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({'passed': False, 'failure': 'guard_or_stage_failed'}))
        raise SystemExit(1)
