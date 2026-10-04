#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit pinned Linux source build, isolated from the owner's files and credentials.

Default is an inert preview. --execute provisions verified build tools and source beneath
this checkout's ignored build directory. Dependency fetching uses a frozen lock and no
lifecycle scripts. The reviewed build executes in a network-denied mount/user namespace.
This is not bit-for-bit reproducibility proof or a complete native application trial.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = 'packages/opencode/src/config/config.ts'
COMMIT = 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76'
MIN_FREE = 8 * 1024**3
MAX_LOG_BYTES = 16 * 1024**2


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size < 65536, 'metadata-file')
    return json.loads(path.read_text())


def pins():
    pin = load(ROOT / 'third_party/opencode.json')
    tool = load(ROOT / 'third_party/opencode-build-tools.json')['bun']
    require(pin['commit'] == COMMIT and pin['tag'] == 'v1.18.34' and pin['bun'] == tool['version'] == '1.3.14',
            'source-version')
    require(pin['repository'] == 'https://github.com/anomalyco/opencode'
            and pin['local_patch'] == 'patches/opencode-no-runtime-installs.patch', 'source-scope')
    require(tool['url'] == 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip'
            and tool['member'] == 'bun-linux-x64/bun' and tool['archive_bytes'] == 35969274
            and tool['archive_sha256'] == '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f',
            'tool-scope')
    require(digest(ROOT / 'third_party/opencode-LICENSE.txt') == pin['license_sha256'], 'license-pin')
    return pin, tool


def build_path(value):
    target = Path(value).absolute()
    allowed = ROOT / 'build'
    require(target.parent == allowed and target.name.startswith('opencode-runtime')
            and target.name not in ('.', '..') and target.resolve() == target, 'build-directory-scope')
    require(not allowed.is_symlink() and not target.is_symlink(), 'build-directory-link')
    if target.exists():
        require(target.is_dir() and target.stat().st_uid == os.getuid()
                and not target.stat().st_mode & 0o077, 'build-directory-owner')
    return target


def write_json(path, value):
    # Generated build records only; source files are patched with reviewed git patches.
    payload = json.dumps(value, indent=2) + '\n'
    with path.open('x', encoding='utf-8') as stream:
        stream.write(payload)
    path.chmod(0o600)


def sandbox(build, *, network, cwd='/build', extra_env=None):
    require(os.getuid() != 0, 'unprivileged-build-required')
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    require(account_home.parent == Path('/home'), 'build-account-home')
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
            '--uid', str(os.getuid()), '--gid', str(os.getgid()), '--unshare-pid', '--unshare-ipc',
            '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--dir', '/etc', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
            '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind', '/etc/group', '/etc/group',
            '--dir', '/etc/ssl', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
            '--dir', str(account_home),
            '--tmpfs', '/tmp', '--dir', '/run', '--proc', '/proc', '--dev', '/dev',
            '--bind', str(build), '/build', '--ro-bind', str(ROOT / 'patches'), '/patches']
    if network:
        args += ['--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf']
    else:
        args += ['--unshare-net']
    environment = {'PATH': '/build/toolchain/bun-linux-x64:/usr/bin:/bin',
                   'LANG': 'C.UTF-8', 'TZ': 'UTC', 'CI': '1', 'HUSKY': '0',
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
                   'BUN_INSTALL_CACHE_DIR': '/build/cache/bun', 'npm_config_userconfig': '/dev/null',
                   'npm_config_ignore_scripts': 'true'}
    environment.update(extra_env or {})
    require(not {'HOME', 'home', 'CODEX_HOME'} & environment.keys(), 'build-environment-scope')
    args += ['--chdir', cwd, '--clearenv']
    for name, value in environment.items():
        args += ['--setenv', name, value]
    return args + ['--']


def run(build, name, command, *, network=False, cwd='/build', extra_env=None, seconds=1800):
    logs = build / 'logs'
    logs.mkdir(exist_ok=True, mode=0o700)
    log = logs / (name + '.log')
    attempt = 1
    while log.exists():
        attempt += 1
        require(attempt <= 100, 'build-stage-attempt-bound')
        log = logs / (name + '-' + str(attempt) + '.log')
    prefix = sandbox(build, network=network, cwd=cwd, extra_env=extra_env)
    # Keep CPU work below the owner's interactive work; no writable host mounts or owner HOME.
    cpus = ','.join(str(cpu) for cpu in sorted(os.sched_getaffinity(0))[:2])
    prefix += ['/usr/bin/nice', '-n', '10', '/usr/bin/taskset', '-c', cpus,
               '/usr/bin/prlimit', '--nofile=8192', '--', *command]
    print(json.dumps({'stage': name, 'network': network, 'log': str(log)}), flush=True)
    with log.open('xb') as output:
        process = subprocess.run(prefix, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                 stdout=output, stderr=subprocess.STDOUT, timeout=seconds, check=False)
    require(log.stat().st_size <= MAX_LOG_BYTES, 'build-log-bound')
    require(process.returncode == 0, 'build-stage-failed-' + name)
    return log.read_text(errors='replace')


def fetch_tool(build, tool):
    downloads = build / 'downloads'
    downloads.mkdir(mode=0o700, exist_ok=True)
    archive = downloads / 'bun-linux-x64.zip'
    if not archive.exists():
        print(json.dumps({'stage': 'download-verified-build-tool', 'bytes': tool['archive_bytes']}), flush=True)
        request = urllib.request.Request(tool['url'], headers={'User-Agent': 'VOLPAROSSA-explicit-source-build/1'})
        # Never inherit proxy credentials from the interactive development environment.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=60) as response, archive.open('xb') as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                require(total <= tool['archive_bytes'], 'build-tool-download-bound')
                output.write(chunk)
    require(archive.stat().st_size == tool['archive_bytes'] and digest(archive) == tool['archive_sha256'],
            'build-tool-checksum')
    destination = build / 'toolchain' / tool['member']
    if not destination.exists():
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            item = source.getinfo(tool['member'])
            require(not item.is_dir() and item.file_size <= tool['maximum_extracted_bytes']
                    and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), 'build-tool-member')
            with source.open(item) as incoming, destination.open('xb') as output:
                shutil.copyfileobj(incoming, output)
        destination.chmod(0o700)
    # Verify an existing extracted executable against the exact validated archive, not merely its name.
    with zipfile.ZipFile(archive) as source, source.open(tool['member']) as stream:
        expected = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(not destination.is_symlink() and digest(destination) == expected, 'build-tool-executable')
    return destination


def source_checks(build, pin, *, patched):
    source = build / 'source'
    require(digest(source / 'bun.lock') == pin['bun_lock_sha256'], 'source-lock-pin')
    require(digest(source / 'LICENSE') == pin['license_sha256'], 'source-license-pin')
    require(load(source / 'package.json')['packageManager'] == 'bun@' + pin['bun'], 'source-tool-version')
    require(load(source / 'packages/opencode/package.json')['version'] == pin['tag'][1:], 'source-runtime-version')
    if not patched:
        require(digest(source / CONFIG) == pin['config_source_sha256'], 'source-config-pin')
    else:
        require(digest(source / CONFIG) == load(build / 'prepared.json')['patched_config_sha256'],
                'patched-source-config-pin')


def prepare(build, pin, tool):
    executable = fetch_tool(build, tool)
    if not (build / 'logs/tool-version.log').exists():
        version = run(build, 'tool-version', ['/build/toolchain/' + tool['member'], '--version'], seconds=30).strip()
        require(version == tool['version'], 'build-tool-version')
    if not (build / 'source').exists():
        run(build, 'source-init', ['git', 'init', '--template=', '/build/source'])
        run(build, 'source-fetch', ['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
            '-c', 'protocol.file.allow=never', 'fetch', '--depth=1', '--no-tags',
            pin['repository'] + '.git', pin['commit']], network=True, cwd='/build/source')
        run(build, 'source-checkout', ['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'],
            cwd='/build/source')
    stamp = build / 'prepared.json'
    if not stamp.exists():
        source_checks(build, pin, patched=False)
        actual = run(build, 'source-commit', ['git', 'rev-parse', 'HEAD'], cwd='/build/source').strip()
        require(actual == pin['commit'], 'source-commit-pin')
        patch = '/patches/' + Path(pin['local_patch']).name
        run(build, 'patch-check', ['git', 'apply', '--check', patch], cwd='/build/source')
        run(build, 'patch-apply', ['git', 'apply', patch], cwd='/build/source')
        write_json(build / 'models.json', {})
        write_json(stamp, {'version': 1, 'source_commit': actual, 'source_build': False,
                          'patch_sha256': digest(ROOT / pin['local_patch']),
                          'patched_config_sha256': digest(build / 'source' / CONFIG),
                          'tool_sha256': digest(executable)})
    else:
        prepared = load(stamp)
        require(prepared['source_commit'] == pin['commit'] and prepared['source_build'] is False
                and prepared['patch_sha256'] == digest(ROOT / pin['local_patch'])
                and prepared['tool_sha256'] == digest(executable), 'prepared-source-binding')
    source_checks(build, pin, patched=True)
    return executable


def build_runtime(build, pin, tool, executable):
    environment = {'OPENCODE_CHANNEL': 'latest', 'OPENCODE_VERSION': pin['tag'][1:],
                   'MODELS_DEV_API_JSON': '/build/models.json', 'VOLPAROSSA_NO_RUNTIME_INSTALLS': '1',
                   'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
                   'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true'}
    if not (build / 'dependencies.json').exists():
        run(build, 'dependencies', ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
            network=True, cwd='/build/source', extra_env=environment, seconds=1800)
        source_checks(build, pin, patched=True)
        write_json(build / 'dependencies.json', {'version': 1, 'lock_sha256': pin['bun_lock_sha256'],
                                               'lifecycle_scripts': False})
    else:
        require(load(build / 'dependencies.json') == {'version': 1, 'lock_sha256': pin['bun_lock_sha256'],
                                                    'lifecycle_scripts': False}, 'dependency-binding')
    changes = run(build, 'source-diff', ['git', 'diff', '--name-only'], cwd='/build/source').splitlines()
    require(changes == [CONFIG], 'unexpected-source-diff')
    run(build, 'patch-reverse-check', ['git', 'apply', '--reverse', '--check',
        '/patches/' + Path(pin['local_patch']).name], cwd='/build/source')
    run(build, 'compile', ['bun', 'run', 'script/build.ts', '--single', '--skip-install', '--skip-embed-web-ui'],
        cwd='/build/source/packages/opencode', extra_env=environment, seconds=1800)
    source_checks(build, pin, patched=True)
    binary = build / 'source/packages/opencode/dist/opencode-linux-x64/bin/opencode'
    require(binary.is_file() and not binary.is_symlink() and binary.stat().st_size > 1024**2
            and os.access(binary, os.X_OK), 'built-binary')
    version = run(build, 'binary-version',
                  ['/build/source/packages/opencode/dist/opencode-linux-x64/bin/opencode', '--version'],
                  extra_env=environment, seconds=60).strip()
    require(version == pin['tag'][1:], 'built-runtime-version')
    report = {'version': 1, 'source_commit': pin['commit'], 'source_build': True,
              'lock_sha256': pin['bun_lock_sha256'], 'patch_sha256': digest(ROOT / pin['local_patch']),
              'binary_sha256': digest(binary), 'runtime_version': version,
              'binary': str(binary), 'binary_bytes': binary.stat().st_size,
              'bun_version': tool['version'], 'bun_archive_sha256': tool['archive_sha256'],
              'bun_binary_sha256': digest(executable), 'license_sha256': pin['license_sha256'],
              'models_snapshot_sha256': digest(build / 'models.json'),
              'dependency_lifecycle_scripts': False, 'build_network': False,
              'embedded_web_ui': False, 'native_session_verified': False,
              'confidential_remote_execution_verified': False,
              'claim_scope': 'pinned_source_build_and_version_probe_not_full_runtime_or_bit_reproducibility'}
    write_json(build / 'build-report.json', report)
    print(json.dumps({'stage': 'source-build-complete', 'binary': str(binary),
                      'report': str(build / 'build-report.json'), 'sha256': report['binary_sha256']}), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-root', default=str(ROOT / 'build/opencode-runtime'))
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args(argv)
    pin, tool = pins()
    build = build_path(args.build_root)
    if not args.execute:
        print(json.dumps({'execute': False, 'source_build': False, 'source_commit': pin['commit'],
                          'build_root': str(build), 'build_tool_download_bytes': tool['archive_bytes'],
                          'fetches_locked_dependencies': not args.prepare_only,
                          'global_install': False, 'owner_home_mounted': False,
                          'dependency_scripts': False, 'compile_network': False}))
        return
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64' and os.getuid() != 0,
            'linux-amd64-unprivileged-build-required')
    require(args.resume == build.exists() and not (build / 'build-report.json').exists(), 'new-or-resumable-build-required')
    require(shutil.disk_usage(ROOT).free >= MIN_FREE, 'workspace-free-space')
    (ROOT / 'build').mkdir(mode=0o700, exist_ok=True)
    build.mkdir(mode=0o700, exist_ok=args.resume)
    executable = prepare(build, pin, tool)
    if not args.prepare_only:
        build_runtime(build, pin, tool, executable)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        # Stage logs stay in the explicit build tree. Do not dump host environment or credentials.
        print(json.dumps({'source_build': False, 'error': str(error)[:512]}), file=sys.stderr)
        sys.exit(1)
