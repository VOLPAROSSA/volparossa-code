#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit native Codex/core coding trial; no downloads or service startup."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = '67727e7cf114cf3e1b71db368d74b24e32f6cb12'
PROMPT_SHA256 = 'ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807'
ORIGINAL = b'def add(a, b):\n    return a - b\n'
SOURCES = ('app-server.cjs', 'private-compute.cjs', 'private-conversation.cjs',
           'responses-provider.cjs', 'native-coding-fixture.cjs')
PHASES = ('capabilities', 'launch', 'initialize', 'thread-start', 'native-turn',
          'independent-check', 'unsubscribe', 'complete')
DIAGNOSTICS = (None, 'stderr_bound', 'turn_deadline', 'native_coding_incomplete',
               'provider_cleanup_unconfirmed')


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verified_file(value, expected, executable=False):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical-file-required')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode)
            and (not executable or not info.st_mode & 0o6022 and os.access(path, os.X_OK))
            and re.fullmatch('[0-9a-f]{64}', expected) and digest(path) == expected,
            'file-hash-or-mode')
    return path


def private_socket(value):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'canonical-socket-required')
    info, parent = path.lstat(), path.parent.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600 and stat.S_ISDIR(parent.st_mode)
            and parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700,
            'private-socket-required')
    return path


def verified_build(value, binary, binary_hash):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file()
            and path.stat().st_size <= 65536, 'build-report-required')
    report = json.loads(path.read_text())
    pin = json.loads((ROOT / 'third_party/codex-runtime.json').read_text())
    require(report.get('version') == 1 and report.get('app_server_built') is True
            and report.get('staged_source_verified') is True and report.get('original_source_unchanged') is True
            and report.get('source_revision') == pin['revision'] == UPSTREAM
            and report.get('source_tree') == pin['tree']
            and report.get('lock_sha256') == pin['sha256']['codex-rs/Cargo.lock']
            and report.get('local_patches') == pin['patches']
            and report.get('binary') == dict(path='runtime/codex-app-server',
                bytes=binary.stat().st_size, sha256=binary_hash)
            and binary == path.parent / 'runtime/codex-app-server', 'build-source-binding')
    notices = {name: digest(verified_file(str(path.parent / 'notices' / name), pin['sha256'][name]))
               for name in ('LICENSE', 'NOTICE')}
    return dict(report_sha256=digest(path), source_revision=pin['revision'], source_tree=pin['tree'],
                lock_sha256=report['lock_sha256'], local_patches=pin['patches'], notices=notices)


def snapshot():
    return dict(network_namespace=os.readlink('/proc/self/ns/net'),
                routes=digest(Path('/proc/net/route')), routes6=digest(Path('/proc/net/ipv6_route')),
                dns=digest(Path('/etc/resolv.conf')))


def command(binary, node, ipc, prompt, work, home):
    # Only system runtime files, exact owned inputs and synthetic state are exposed.
    # No broad root/home/workspace bind and no HOME/CODEX_HOME override.
    result = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
        '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-net', '--unshare-pid',
        '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--dir', '/etc', '--ro-bind', '/etc/passwd', '/etc/passwd',
        '--ro-bind', '/etc/group', '/etc/group', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
        '--tmpfs', '/tmp', '--dir', '/run', '--dir', '/opt', '--dir', '/opt/src',
        '--dir', home, '--proc', '/proc', '--dev', '/dev',
        '--ro-bind', str(binary), '/opt/codex-app-server', '--ro-bind', str(node), '/opt/node',
        '--ro-bind', str(prompt), '/opt/upstream-prompt.md',
        '--ro-bind', str(work / 'ipc'), '/opt/core', '--ro-bind', str(ipc), '/opt/core/compute.sock',
        '--bind', str(work / 'state'), '/opt/work']
    for source in SOURCES:
        result += ['--ro-bind', str(ROOT / 'src' / source), '/opt/src/' + source]
    for source, destination in (('smoke_native_coding.cjs', '/opt/smoke_native_coding.cjs'),
            ('native_coding_fixture.py', '/opt/fixture.py'), ('smoke_native_coding.py', '/opt/runner.py')):
        result += ['--ro-bind', str(ROOT / 'scripts' / source), destination]
    return result + ['--chdir', '/opt/work/project', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'LANG', 'C.UTF-8', '--', '/usr/bin/python3', '-B', '/opt/runner.py',
        '--inside', os.readlink('/proc/self/ns/net')]


def inside(parent):
    require(os.geteuid() != 0 and os.readlink('/proc/self/ns/net') != parent, 'isolation')
    require({name for _, name in socket.if_nameindex()} <= {'lo'}, 'network-isolation')
    caps = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
                if line.startswith('CapEff:'))
    require(int(caps, 16) == 0, 'capability-isolation')
    require(not any(name in os.environ for name in ('HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL')),
            'clean-environment')
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    require(account_home.is_dir() and not list(account_home.iterdir()), 'empty-isolated-home')
    private_socket('/opt/core/compute.sock')
    return subprocess.run(['/opt/node', '/opt/smoke_native_coding.cjs'], check=False, timeout=2470).returncode


def closed_receipt(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 8192, 'receipt-bound')
    value = json.loads(path.read_text())
    booleans = ('success', 'native_turn_completed', 'read', 'edit', 'test', 'independent_test_passed',
                'unexpected_command', 'thread_unsubscribed', 'private_peer_execution_claimed',
                'general_coding_quality_claimed', 'forced_stop')
    keys = set(booleans) | {'version', 'kind', 'phase', 'model', 'full_native_prompt_sha256',
        'before_sha256', 'after_sha256', 'accepted_commands', 'declined_commands', 'responses',
        'runtime_exit', 'diagnostic'}
    require(isinstance(value, dict) and set(value) == keys, 'receipt-schema')
    require(value['version'] == 1 and value['kind'] == 'native-codex-core-coding'
            and value['model'] == 'qwen3-0.6b-v1' and value['phase'] in PHASES
            and value['diagnostic'] in DIAGNOSTICS and all(type(value[key]) is bool for key in booleans),
            'receipt-values')
    require(value['full_native_prompt_sha256'] == PROMPT_SHA256
            and value['before_sha256'] == hashlib.sha256(ORIGINAL).hexdigest()
            and (value['after_sha256'] is None or isinstance(value['after_sha256'], str)
                 and re.fullmatch('[0-9a-f]{64}', value['after_sha256']))
            and value['private_peer_execution_claimed'] is False
            and value['general_coding_quality_claimed'] is False, 'receipt-scope')
    for key in ('accepted_commands', 'declined_commands'):
        require(type(value[key]) is int and 0 <= value[key] <= 16, 'receipt-count')
    require(value['runtime_exit'] is None or type(value['runtime_exit']) is int
            and -255 <= value['runtime_exit'] <= 255, 'receipt-exit')
    counters = value['responses']
    require(counters is None or isinstance(counters, dict)
            and set(counters) == {'submitted', 'completed', 'incomplete', 'cleanup_confirmed'}
            and all(type(v) is int and 0 <= v <= 32 for v in counters.values()), 'receipt-responses')
    if value['success']:
        require(all(value[key] for key in ('native_turn_completed', 'read', 'edit', 'test',
                    'independent_test_passed', 'thread_unsubscribed'))
                and value['phase'] == 'complete' and value['runtime_exit'] == 0
                and not value['unexpected_command'] and not value['forced_stop'] and value['diagnostic'] is None
                and value['after_sha256'] not in (None, value['before_sha256'])
                and counters is not None and counters['completed'] >= 4 and counters['incomplete'] == 0
                and counters['submitted'] == counters['completed'] == counters['cleanup_confirmed'],
                'receipt-success-unproven')
    return value


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def run(args):
    require(os.getuid() != 0, 'root-refused')
    binary = verified_file(args.app_server, args.app_server_sha256, executable=True)
    provenance = verified_build(args.build_report, binary, args.app_server_sha256)
    node = verified_file(args.node, args.node_sha256, executable=True)
    prompt = verified_file(args.upstream_prompt, PROMPT_SHA256)
    ipc = private_socket(args.socket)
    require(prompt.stat().st_size == 20903, 'native-prompt-size')
    home = pwd.getpwuid(os.getuid()).pw_dir
    require(Path(home).parent == Path('/home') and Path(home).name not in ('', '.', '..'), 'account-home')
    output = Path(args.output)
    require(output.is_absolute() and output.parent.resolve(strict=True) == output.parent
            and output.parent.is_relative_to(ROOT / 'build') and not output.exists()
            and not output.is_symlink(), 'new-workspace-output-required')
    plan = dict(kind='native-codex-core-coding', upstream_revision=UPSTREAM,
        app_server_sha256=args.app_server_sha256, node_sha256=args.node_sha256,
        native_prompt_sha256=PROMPT_SHA256, model='qwen3-0.6b-v1',
        model_download=False, service_started=False, private_peer_execution_claimed=False,
        actions=['connect to existing same-owner private core', 'isolate synthetic arithmetic project',
                 'native model-driven read/edit/test with exact per-command approval',
                 'independent arithmetic tests', 'unsubscribe and stop runtime', 'remove private fixture'])
    print(json.dumps(plan), flush=True)
    if not args.execute:
        require(not args.yes, 'execute-required')
        return 0
    require(args.yes, 'explicit-confirmation-required')
    output.mkdir(mode=0o700)
    work = Path(tempfile.mkdtemp(prefix='private-', dir=output))
    (work / 'ipc').mkdir(mode=0o700)
    (work / 'ipc/compute.sock').touch(mode=0o600)
    (work / 'state').mkdir(mode=0o700)
    (work / 'state/project').mkdir(mode=0o700)
    (work / 'state/project/arithmetic.py').write_bytes(ORIGINAL)
    (work / 'state/project/arithmetic.py').chmod(0o600)
    before = snapshot()
    result = dict(version=1, kind=plan['kind'], success=False, plan=plan, before=before,
        runtime_provenance=provenance,
        source_sha256={str(path.relative_to(ROOT)): digest(path) for path in
            [*(ROOT / 'src' / name for name in SOURCES), ROOT / 'scripts/smoke_native_coding.cjs',
             ROOT / 'scripts/native_coding_fixture.py', Path(__file__).resolve()]})
    process = None
    previous = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    for number in previous:
        signal.signal(number, interrupted)
    try:
        process = subprocess.Popen(command(binary, node, ipc, prompt, work, home),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        result['exit_code'] = process.wait(timeout=2500)
        result['observed'] = closed_receipt(work / 'state/receipt.json')
        result['success'] = result['exit_code'] == 0 and result['observed']['success']
    except (OSError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt):
        result['failure'] = 'native-coding-incomplete'
    finally:
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            result['success'] = False
        joined = process is None or process.poll() is not None
        if joined:
            shutil.rmtree(work)
        result['after'] = snapshot()
        result['cleanup'] = dict(process_joined=joined, private_state_removed=not work.exists(),
                                host_network_unchanged=before == result['after'])
        result['success'] &= all(result['cleanup'].values())
        with (output / 'report.json').open('x') as target:
            json.dump(result, target, indent=2)
            target.write('\n')
        (output / 'report.json').chmod(0o600)
        for number, handler in previous.items():
            signal.signal(number, handler)
    print(json.dumps({'success': result['success'], 'cleanup': result['cleanup']}), flush=True)
    return 0 if result['success'] else 1


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        return inside(sys.argv[2])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-server', required=True)
    parser.add_argument('--app-server-sha256', required=True)
    parser.add_argument('--build-report', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--upstream-prompt', required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--yes', action='store_true')
    return run(parser.parse_args())


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print('native-coding-preflight-failed', file=sys.stderr)
        raise SystemExit(1) from None
