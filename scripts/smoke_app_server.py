#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit, disposable native app-server protocol trial. Not an inference proof."""
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


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def executable(value, expected):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path
            and path.is_relative_to(ROOT.parent), 'workspace-executable-required')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o6022
            and os.access(path, os.X_OK) and re.fullmatch('[0-9a-f]{64}', expected)
            and digest(path) == expected, 'executable-hash-or-mode')
    return path


def snapshot():
    return dict(network_namespace=os.readlink('/proc/self/ns/net'),
        routes=digest(Path('/proc/net/route')), routes6=digest(Path('/proc/net/ipv6_route')),
        dns=digest(Path('/etc/resolv.conf')))


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def command(binary, node, work, home):
    # /etc exposes only account resolution, not host managed Codex configuration.
    return ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
        '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-net', '--unshare-pid',
        '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/', '/',
        '--tmpfs', '/home', '--tmpfs', '/root', '--tmpfs', '/run', '--tmpfs', '/media',
        '--tmpfs', '/mnt', '--tmpfs', '/tmp', '--tmpfs', '/opt', '--tmpfs', '/etc',
        '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
        '--dir', home, '--proc', '/proc', '--dev', '/dev',
        '--ro-bind', str(binary), '/opt/codex-app-server', '--ro-bind', str(node), '/opt/node',
        '--ro-bind', str(ROOT / 'src/app-server.cjs'), '/opt/app-server-client.cjs',
        '--ro-bind', str(ROOT / 'scripts/smoke_app_server.cjs'), '/opt/smoke_app_server.cjs',
        '--ro-bind', str(Path(__file__).resolve()), '/opt/smoke_app_server.py',
        '--bind', str(work), '/opt/work', '--chdir', '/opt/work/project', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
        '--', '/usr/bin/python3', '-B', '/opt/smoke_app_server.py', '--inside',
        os.readlink('/proc/self/ns/net')]


def inside(parent):
    require(os.geteuid() != 0 and os.readlink('/proc/self/ns/net') != parent, 'isolation')
    require({name for _, name in socket.if_nameindex()} <= {'lo'}, 'network-isolation')
    # HOME/CODEX_HOME remain absent. Upstream resolves the passwd home in tmpfs.
    account = pwd.getpwuid(os.getuid())
    require(Path(account.pw_dir).is_dir() and not list(Path(account.pw_dir).iterdir()), 'empty-isolated-home')
    require(not any(name in os.environ for name in ('HOME', 'CODEX_HOME', 'OPENAI_API_KEY')), 'clean-environment')
    return subprocess.run(['/opt/node', '/opt/smoke_app_server.cjs'], check=False, timeout=100).returncode


def run(args):
    require(os.getuid() != 0, 'root-refused')
    binary = executable(args.app_server, args.app_server_sha256)
    node = executable(args.node, args.node_sha256)
    home = pwd.getpwuid(os.getuid()).pw_dir
    require(Path(home).parent == Path('/home') and Path(home).name not in ('', '.', '..'), 'account-home')
    output = Path(args.output)
    require(output.is_absolute() and output.parent.resolve(strict=True) == output.parent
            and output.parent.is_relative_to(ROOT / 'build')
            and not output.exists() and not output.is_symlink(), 'new-workspace-output-required')
    plan = dict(kind='native-codex-app-server-protocol', app_server_sha256=args.app_server_sha256,
        node_sha256=args.node_sha256, changed_host_network=False, private_user_config_access=False,
        new_namespaces=['user', 'network', 'pid', 'mount', 'ipc', 'uts'],
        actions=['initialize', 'ephemeral VOLPAROSSA thread', 'unsubscribe', 'shutdown', 'remove private fixture'],
        model_download=False, inference_proven=False, tools_proven=False)
    print(json.dumps(plan), flush=True)
    if not args.execute:
        require(not args.yes, 'execute-required')
        return 0
    require(args.yes, 'explicit-confirmation-required')
    output.mkdir(mode=0o700)
    work = Path(tempfile.mkdtemp(prefix='private-', dir=output))
    (work / 'project').mkdir(mode=0o700)
    before = snapshot()
    result = dict(version=1, kind=plan['kind'], success=False, plan=plan, before=before,
        client_sha256=digest(ROOT / 'src/app-server.cjs'), driver_sha256=digest(ROOT / 'scripts/smoke_app_server.cjs'))
    process = None
    previous_handlers = {number: signal.getsignal(number)
                         for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    for number in previous_handlers:
        signal.signal(number, interrupted)
    try:
        with (work / 'runner.log').open('xb') as log:
            process = subprocess.Popen(command(binary, node, work, home), stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
            result['exit_code'] = process.wait(timeout=115)
        receipt = work / 'receipt.json'
        if receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size <= 8192:
            observed = json.loads(receipt.read_text())
            require(set(observed) == {'version', 'phase', 'success', 'initialize', 'thread_started',
                'provider_selected', 'ephemeral', 'thread_unsubscribed',
                'inference_proven', 'tools_proven', 'core_model_connection_proven', 'runtime_exit',
                'forced_stop', 'diagnostic', 'stderr_bounded'}, 'closed-receipt')
            require(observed['diagnostic'] in (None, 'app_server_rejected', 'rpc_closed',
                'rpc_unavailable', 'thread_scope', 'lifecycle_check_failed'), 'closed-error')
            require(observed['phase'] in ('launch', 'initialize', 'thread-start', 'thread-unsubscribe',
                'shutdown', 'complete'), 'closed-phase')
            result['observed'] = observed
            result['success'] = result['exit_code'] == 0 and observed['success'] is True
    except (OSError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt):
        result['failure'] = 'native-lifecycle-incomplete'
    finally:
        # Repeated supervisor cancellation must not interrupt bounded teardown.
        for number in previous_handlers:
            signal.signal(number, signal.SIG_IGN)
        if process is not None and process.poll() is None:
            # Only this live, newly created session, never an inferred host process.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            result['success'] = False
        # Bubblewrap's owned PID namespace is gone after its init exits.
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
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)
    print(json.dumps({'success': result['success'], 'cleanup': result['cleanup']}), flush=True)
    return 0 if result['success'] else 1


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        return inside(sys.argv[2])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-server', required=True)
    parser.add_argument('--app-server-sha256', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--yes', action='store_true')
    return run(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(main())
