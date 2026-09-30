#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicit, workspace-only build of the pinned open Codex app-server. Never run it."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import signal
import stat
import subprocess
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'third_party/codex-runtime.json'
MAX_FILE = 2 * 1024**3
MAX_STATE = 40 * 1024**3
MAX_LOG = 32 * 1024**2


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')


def relative(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and str(path) == name and
            all(part not in ('', '.', '..') for part in path.parts) and
            '\\' not in name and all(32 <= ord(char) != 127 for char in name), 'unsafe source path')
    return Path(name)


def git(source, *args):
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'}
    return subprocess.check_output(['/usr/bin/git', '-C', str(source), *args], env=env, timeout=30)


def source_files(source, pin):
    require(source.is_dir() and source.resolve() == source, 'source must be a canonical local checkout')
    require(git(source, 'rev-parse', 'HEAD').decode().strip() == pin['revision'], 'upstream revision differs')
    require(git(source, 'rev-parse', 'HEAD^{tree}').decode().strip() == pin['tree'], 'upstream tree differs')
    require(not git(source, 'status', '--porcelain=v1', '--untracked-files=all'), 'upstream checkout is not clean')
    records = {}
    for row in git(source, 'ls-tree', '-rz', '--full-tree', pin['revision']).split(b'\0'):
        if not row:
            continue
        metadata, raw_name = row.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split()
        name = raw_name.decode('utf-8')
        target = source / relative(name)
        info = target.lstat()
        require(kind == 'blob' and mode in ('100644', '100755', '120000') and info.st_size <= 64 * 1024**2,
                'unsupported source entry')
        if mode == '120000':
            require(target.is_symlink(), 'source link replaced')
            data = os.readlink(target).encode()
            require(not Path(os.readlink(target)).is_absolute() and target.resolve().is_relative_to(source),
                    'source link escapes checkout')
        else:
            require(stat.S_ISREG(info.st_mode) and not target.is_symlink(), 'source regular file replaced')
            data = target.read_bytes()
        require(hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == blob,
                'source content differs from pinned Git blob')
        records[name] = dict(mode=mode, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    require(0 < len(records) <= 30000, 'source entry bound')
    for name, expected in pin['sha256'].items():
        require(records[name]['sha256'] == expected, 'pinned source file differs')
    return records


def snapshot(source, output, records):
    output.mkdir(mode=0o700)
    for name, record in records.items():
        target = output / relative(name)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if record['mode'] == '120000':
            target.symlink_to(os.readlink(source / name))
        else:
            shutil.copyfile(source / name, target)
            target.chmod(0o700 if record['mode'] == '100755' else 0o600)
    verify_snapshot(output, records)


def verify_snapshot(output, records):
    observed = {str(path.relative_to(output)) for path in output.rglob('*')
                if path.is_symlink() or not path.is_dir()}
    require(observed == set(records), 'source snapshot entries changed')
    for name, record in records.items():
        path = output / name
        if record['mode'] == '120000':
            require(path.is_symlink() and path.resolve().is_relative_to(output), 'snapshot link changed')
            actual = hashlib.sha256(os.readlink(path).encode()).hexdigest()
        else:
            require(path.is_file() and not path.is_symlink(), 'snapshot regular file changed')
            actual = digest(path)
        require(actual == record['sha256'], 'source snapshot bytes changed')


def patched_records(records, pin):
    require(len(pin['patches']) == 1, 'only the reviewed compatibility patch is allowed')
    patch = pin['patches'][0]
    require(patch['file'] == 'patches/codex-chatgpt-recursion-limit.patch' and
            patch['target'] == 'codex-rs/chatgpt/src/lib.rs' and
            digest(ROOT / relative(patch['file'])) == patch['sha256'] and
            records[patch['target']]['sha256'] == patch['original_sha256'], 'compatibility patch binding differs')
    updated = {name: dict(record) for name, record in records.items()}
    updated[patch['target']].update(bytes=patch['patched_bytes'], sha256=patch['patched_sha256'])
    return updated


def patch_snapshot(output, original, updated, pin):
    verify_snapshot(output, original)
    subprocess.run(['/usr/bin/patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1',
                    '-i', str(ROOT / pin['patches'][0]['file'])], cwd=output, check=True,
                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=10)
    verify_snapshot(output, updated)


def toolchain(root, pin):
    require(root.resolve() == root and root.is_dir(), 'compiler directory must be canonical')
    report_path = root / 'TOOLCHAIN_REPORT.json'
    require(digest(report_path) == pin['toolchain_report_sha256'], 'compiler provenance differs')
    report = json.loads(report_path.read_text())
    require(report['pin']['rust_version'] == '1.98.1' and
            report['pin']['host'] == 'x86_64-unknown-linux-gnu', 'unsupported compiler')
    for name, record in report['files'].items():
        path = root / relative(name)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_size == record['size'] and
                stat.S_IMODE(info.st_mode) == record['mode'] and digest(path) == record['sha256'],
                'compiler file differs from verified distribution')
    return root / 'toolchain'


def locked_sources(path):
    lock = tomllib.loads(path.read_text())
    sources = set()
    for package in lock['package']:
        source = package.get('source')
        if not source:
            continue
        if source.startswith('registry+'):
            require(source == 'registry+https://github.com/rust-lang/crates.io-index' and
                    re.fullmatch('[0-9a-f]{64}', package.get('checksum', '')), 'unbound registry dependency')
        else:
            match = re.fullmatch(r'git\+https://github.com/[^?#]+\?rev=([0-9a-f]{40})#([0-9a-f]{40})', source)
            require(match and match[1] == match[2], 'unbound Git dependency')
        sources.add(source)
    return sorted(sources)


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE, MAX_FILE))
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])


def size_bound(state):
    total = 0
    for directory, dirs, names in os.walk(state, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in names:
            path = Path(directory) / name
            try:
                if not path.is_symlink():
                    size = path.stat().st_size
                    require(size <= MAX_FILE, 'build file bound exceeded')
                    total += size
            except FileNotFoundError:
                pass  # Cargo temporary files are atomically renamed.
    require(total <= MAX_STATE, 'build storage bound exceeded')
    return total


def run_step(name, argv, env, state, *, network=False, seconds=3600, json_output=False):
    source = state / 'source'
    command = ['/usr/bin/bwrap', '--die-with-parent', '--ro-bind', '/', '/',
               '--tmpfs', '/home', '--tmpfs', '/root', '--tmpfs', '/run', '--tmpfs', '/tmp',
               '--bind', str(state), str(state), '--ro-bind', str(source), str(source),
               '--proc', '/proc', '--dev', '/dev', '--chdir', str(source / 'codex-rs')]
    if not network:
        command += ['--unshare-net']
    command += ['--'] + argv
    stamp = time.time_ns()
    log = state / f'{name}-{stamp}.log'
    stdout = state / f'{name}-{stamp}.stdout.json' if json_output else log
    receipt = state / f'{name}-{stamp}.json'
    report = dict(version=1, step=name, argv=argv, passed=False, network_enabled=network,
                  source_read_only=True, compiler_jobs=2, private_home_hidden=True,
                  app_server_executed=False, log=log.name)
    process, start = None, time.monotonic()
    try:
        with ExitStack() as stack:
            stream = stack.enter_context(log.open('xb'))
            out = stack.enter_context(stdout.open('xb')) if json_output else stream
            process = subprocess.Popen(command, env=env, stdout=out, stderr=stream,
                                       start_new_session=True, preexec_fn=limits)
            print(json.dumps(dict(step=name, log=str(log))), flush=True)
            next_size_check = 0
            while process.poll() is None:
                elapsed = time.monotonic() - start
                require(elapsed < seconds, 'step deadline exceeded')
                require(log.stat().st_size <= MAX_LOG and stdout.stat().st_size <= MAX_LOG, 'build log bound exceeded')
                if elapsed >= next_size_check:
                    size_bound(state)
                    next_size_check = elapsed + 30
                time.sleep(1)
            report['exit_code'] = process.returncode
            require(process.returncode == 0, f'{name} failed; inspect {log.name}')
            report['passed'] = True
    finally:
        if process is not None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            process.wait(timeout=10)
        report.update(elapsed_seconds=round(time.monotonic() - start, 3), log_sha256=digest(log))
        write(receipt, report)
        print(json.dumps(dict(step=name, passed=report['passed'], receipt=str(receipt))), flush=True)
    return stdout


def retain_notices(metadata, state):
    """Retain original notices and source metadata, not a redistribution-license certification."""
    output = state / 'notices/dependencies'
    output.mkdir(parents=True, mode=0o700)
    records = []
    for index, package in enumerate(metadata['packages']):
        source = Path(package['manifest_path']).parent
        require(source.is_relative_to(state / 'source') or source.is_relative_to(state / 'cargo'),
                'dependency outside private source/cache')
        names = set()
        explicit = package.get('license_file')
        if explicit:
            path = source / explicit
            require(path.resolve().is_relative_to(state) and path.is_file(), 'invalid dependency license file')
            names.add(path)
        for path in source.rglob('*'):
            if path.is_file() and path.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT')):
                require(path.resolve().is_relative_to(state), 'dependency notice escapes cache')
                names.add(path)
        notices = []
        for item, path in enumerate(sorted(names)):
            require(path.stat().st_size <= 32 * 1024**2, 'dependency notice bound')
            target = output / f'{index}-{item}-{path.name}'
            shutil.copyfile(path, target)
            notices.append(dict(source=str(path.relative_to(state)), file=str(target.relative_to(state)), sha256=digest(target)))
        records.append(dict(id=package['id'], name=package['name'], version=package['version'],
                            license=package.get('license'), notices=notices))
    write(state / 'notices/dependencies.json', records)


def build(args):
    require(os.getuid() != 0, 'build must be unprivileged')
    pin = json.loads(PIN.read_text())
    existing = json.loads((ROOT / 'third_party/codex.json').read_text())
    require(pin['revision'] == existing['revision'] and pin['upstream_modified'] is True and
            pin['upstream_checkout_modified'] is False, 'source pins disagree')
    source = args.source.absolute()
    records = source_files(source, pin)
    staged_records = patched_records(records, pin)
    compiler = toolchain(args.toolchain.absolute(), pin)
    dependencies = locked_sources(source / 'codex-rs/Cargo.lock')
    state = ROOT / 'build/codex-runtime'
    require(not state.is_symlink() and state.resolve() == state, 'build path is not canonical')
    binding = dict(version=1, revision=pin['revision'], tree=pin['tree'], source_files=records,
                   pin_sha256=digest(PIN), toolchain=str(compiler), jobs=2, profile='dev-small',
                   incremental=False, dependencies=dependencies)
    previous_binding = dict(binding, pin_sha256=pin['previous_unpatched_pin_sha256'])
    binding.update(version=2, patches=pin['patches'], staged_files=staged_records)
    if args.resume:
        owner = state / 'BUILD_OWNER.json'
        observed_binding = json.loads(owner.read_text())
        if observed_binding == previous_binding:
            require(args.apply_compatibility_patch, 'unpatched state requires explicit --apply-compatibility-patch')
            backup = state / 'BUILD_OWNER.before-compatibility.json'
            if backup.exists():
                require(json.loads(backup.read_text()) == previous_binding, 'previous source provenance differs')
            else:
                write(backup, previous_binding)
            if digest(state / 'source' / pin['patches'][0]['target']) == pin['patches'][0]['original_sha256']:
                patch_snapshot(state / 'source', records, staged_records, pin)
            verify_snapshot(state / 'source', staged_records)
            pending = state / 'BUILD_OWNER.compatibility.json'
            if pending.exists():
                require(json.loads(pending.read_text()) == binding, 'pending patch provenance differs')
            else:
                write(pending, binding)
            pending.replace(owner)
        else:
            require(observed_binding == binding, 'resume input binding differs')
        verify_snapshot(state / 'source', staged_records)
        require(not (state / 'runtime').exists(), 'runtime already staged; do not overwrite')
    else:
        require(not state.exists(), 'build state exists; use explicit --resume')
        state.parent.mkdir(mode=0o700, exist_ok=True)
        state.mkdir(mode=0o700)
        write(state / 'BUILD_OWNER.json', binding)
        snapshot(source, state / 'source', records)
        patch_snapshot(state / 'source', records, staged_records, pin)
        for directory in ('cargo', 'target', 'tmp', 'notices'):
            (state / directory).mkdir(mode=0o700)
        for name in ('LICENSE', 'NOTICE'):
            shutil.copyfile(source / name, state / 'notices' / name)
    require(shutil.disk_usage(state).free >= 12 * 1024**3, 'less than 12GiB free for bounded build')
    env = {'PATH': str(compiler / 'bin') + ':/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'CARGO_HOME': str(state / 'cargo'), 'CARGO_TARGET_DIR': str(state / 'target'),
           'RUSTC': str(compiler / 'bin/rustc'), 'RUSTDOC': str(compiler / 'bin/rustdoc'),
           'TMPDIR': str(state / 'tmp'), 'CARGO_BUILD_JOBS': '2', 'CARGO_INCREMENTAL': '0',
           'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_NET_RETRY': '0', 'CARGO_HTTP_TIMEOUT': '60',
           'CARGO_NET_GIT_FETCH_WITH_CLI': 'false', 'CARGO_TERM_COLOR': 'never',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    cargo = str(compiler / 'bin/cargo')
    if args.fetch:
        run_step('fetch', [cargo, 'fetch', '--locked', '--target', 'x86_64-unknown-linux-gnu'],
                 env, state, network=True, seconds=1200)
    metadata_log = run_step('metadata', [cargo, 'metadata', '--offline', '--locked', '--format-version', '1',
                                       '--filter-platform', 'x86_64-unknown-linux-gnu'], env, state, seconds=120,
                            json_output=True)
    metadata = json.loads(metadata_log.read_text())
    if not (state / 'notices/dependencies.json').exists():
        retain_notices(metadata, state)
    run_step('compile', [cargo, 'build', '--offline', '--locked', '--profile', 'dev-small',
                        '-p', 'codex-app-server', '--bin', 'codex-app-server'], env, state)
    require(source_files(source, pin) == records, 'upstream changed during build')
    verify_snapshot(state / 'source', staged_records)
    toolchain(args.toolchain.absolute(), pin)
    binary = state / 'target/dev-small/codex-app-server'
    require(binary.is_file() and not binary.is_symlink(), 'compiled executable absent')
    with binary.open('rb') as stream:
        require(stream.read(4) == b'\x7fELF', 'compiled output is not ELF')
    runtime = state / 'runtime'
    runtime.mkdir(mode=0o700)
    shutil.copyfile(binary, runtime / 'codex-app-server')
    (runtime / 'codex-app-server').chmod(0o700)
    for name in ('LICENSE', 'NOTICE'):
        shutil.copyfile(state / 'notices' / name, runtime / name)
    report = dict(version=1, source_revision=pin['revision'], source_tree=pin['tree'],
                  lock_sha256=pin['sha256']['codex-rs/Cargo.lock'], original_source_unchanged=True,
                  staged_source_verified=True, local_patches=pin['patches'],
                  toolchain_report_sha256=pin['toolchain_report_sha256'], rust_version='1.98.1',
                  upstream_toolchain='1.95.0', profile='dev-small', jobs=2,
                  binary=dict(path='runtime/codex-app-server', bytes=binary.stat().st_size, sha256=digest(binary)),
                  app_server_built=True, app_server_executed=False, inference_proven=False,
                  tool_execution_proven=False, global_installation=False, bit_reproducibility_proven=False,
                  dependency_notices='notices/dependencies.json', redistribution_audit_complete=False)
    write(state / 'BUILD_REPORT.json', report)
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='explicit source build; no app-server execution')
    parser.add_argument('--fetch', action='store_true', help='explicit locked source-dependency download before offline compilation')
    parser.add_argument('--resume', action='store_true', help='reuse exactly bound private build state')
    parser.add_argument('--apply-compatibility-patch', action='store_true',
                        help='explicitly migrate the known original failed state to the one recorded source patch')
    parser.add_argument('--source', type=Path, default=ROOT / '.git/upstream-codex')
    parser.add_argument('--toolchain', type=Path, required=True, help='existing verified workspace Rust provision; never installed/downloaded here')
    args = parser.parse_args()
    require(args.build, 'explicit --build required')
    build(args)


if __name__ == '__main__':
    main()
