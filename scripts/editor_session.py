#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit owner-selected editor session. No downloads, models or core startup."""
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys

from smoke_native_coding import (PROMPT_SHA256, private_socket, require,
                                 verified_build, verified_file)

ROOT = Path(__file__).resolve().parents[1]
FIELDS = {'version', 'appServer', 'appServerSha256', 'buildReport', 'node',
          'nodeSha256', 'upstreamPrompt', 'socketPath'}
SOURCES = ('private-compute.cjs', 'private-conversation.cjs',
           'responses-provider.cjs', 'native-coding-fixture.cjs')


def owned(path):
    info = path.lstat()
    require(info.st_uid in (0, os.getuid()) and not info.st_mode & 0o6022,
            'input-ownership')
    return path


def selected_workspace(value, inputs, home, protected=()):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            'canonical-workspace-required')
    info = path.lstat()
    broad = {Path(name) for name in ('/', '/home', '/root', '/tmp', '/var', '/var/tmp',
                                    '/usr', '/etc', '/run', '/media', '/mnt', '/opt')}
    broad.update((Path(home), *Path(home).parents))
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o022 and path not in broad and not path.is_mount()
            and os.access(path, os.R_OK | os.W_OK | os.X_OK), 'selected-project-required')
    # Never expose the launcher/runtime/core authority as writable project data.
    require(all(not item.is_relative_to(path) for item in inputs)
            and all(not path.is_relative_to(item) for item in protected), 'project-input-overlap')
    return path


def validate(config, workspace):
    require(os.getuid() != 0, 'root-refused')
    require(type(config) is dict and set(config) == FIELDS and type(config['version']) is int
            and config['version'] == 1, 'configuration-schema')
    require(all(type(config[name]) is str and 0 < len(config[name]) <= 4096
                and '\0' not in config[name] for name in FIELDS - {'version'}), 'configuration-fields')
    binary = owned(verified_file(config['appServer'], config['appServerSha256'], executable=True))
    report = owned(Path(config['buildReport']))
    verified_build(str(report), binary, config['appServerSha256'])
    node = owned(verified_file(config['node'], config['nodeSha256'], executable=True))
    prompt = owned(verified_file(config['upstreamPrompt'], PROMPT_SHA256))
    require(prompt.stat().st_size == 20903, 'native-prompt-size')
    ipc = private_socket(config['socketPath'])
    home = pwd.getpwuid(os.getuid()).pw_dir
    require(Path(home).parent == Path('/home') and Path(home).name not in ('', '.', '..'), 'account-home')
    project = selected_workspace(workspace, (binary, report, node, prompt, ipc, ROOT), home,
                                 protected=(ROOT, report.parent))
    return binary, node, ipc, prompt, project, home


def command(binary, node, ipc, prompt, project, home):
    # New mount/net/PID namespaces, only system runtimes and exact owned inputs.
    # The owner's actual home contents and environmental credentials never enter.
    result = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
        '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-net', '--unshare-pid',
        '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--dir', '/etc',
        '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
        '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache', '--tmpfs', '/tmp',
        '--dir', '/run', '--tmpfs', '/opt', '--dir', '/opt/src', '--dir', '/opt/scripts',
        '--dir', home, '--perms', '0700', '--dir', '/opt/core',
        '--proc', '/proc', '--dev', '/dev',
        '--ro-bind', str(binary), '/opt/codex-app-server', '--ro-bind', str(node), '/opt/node',
        '--ro-bind', str(prompt), '/opt/upstream-prompt.md',
        '--ro-bind', str(ipc), '/opt/core/compute.sock', '--bind', str(project), '/workspace']
    for name in SOURCES:
        result += ['--ro-bind', str(ROOT / 'src' / name), '/opt/src/' + name]
    for name in ('editor_session.py', 'editor_session.cjs', 'smoke_native_coding.py'):
        result += ['--ro-bind', str(ROOT / 'scripts' / name), '/opt/scripts/' + name]
    return result + ['--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'LANG', 'C.UTF-8', '--', '/usr/bin/python3', '-B',
        '/opt/scripts/editor_session.py', '--inside', os.readlink('/proc/self/ns/net')]


def clean_environment(environment):
    # bwrap itself sets PWD for --chdir after --clearenv. It is not inherited
    # owner configuration; accept only the selected namespace-local directory.
    require(set(environment) <= {'PATH', 'LANG', 'LC_CTYPE', 'PWD'}
            and environment.get('PWD', '/workspace') == '/workspace', 'clean-environment')


def inside(parent):
    require(os.geteuid() != 0 and os.readlink('/proc/self/ns/net') != parent, 'isolation')
    require({name for _, name in socket.if_nameindex()} <= {'lo'}, 'network-isolation')
    caps = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
                if line.startswith('CapEff:'))
    require(int(caps, 16) == 0, 'capability-isolation')
    clean_environment(os.environ)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    require(home.is_dir() and not list(home.iterdir()), 'empty-isolated-home')
    private_socket('/opt/core/compute.sock')
    os.execve('/opt/node', ['/opt/node', '/opt/scripts/editor_session.cjs'],
              {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate-configuration-field')
        result[key] = value
    return result


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--inside':
        inside(sys.argv[2])
    require(len(sys.argv) == 4 and sys.argv[1] == '--execute', 'explicit-execution-required')
    require(len(sys.argv[2]) <= 32768, 'configuration-bound')
    values = validate(json.loads(sys.argv[2], object_pairs_hook=no_duplicates), sys.argv[3])
    owned(Path('/usr/bin/bwrap'))
    # exec, not a detached wrapper: the editor tracks the actual sandbox owner.
    os.execve('/usr/bin/bwrap', command(*values), {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        # Paths/configuration and underlying stderr never become editor output.
        sys.exit(1)
