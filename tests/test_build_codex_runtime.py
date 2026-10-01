# SPDX-License-Identifier: GPL-3.0-only
"""Offline build-boundary tests; never execute Cargo, Codex or download data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/build_codex_runtime.py'
SPEC = importlib.util.spec_from_file_location('builder', SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BuildBoundaries(unittest.TestCase):
    def test_only_fetch_resolves_and_binds_one_resolver_file(self):
        state = Path('/private/build')
        with patch.object(BUILDER.Path, 'resolve', side_effect=AssertionError('offline resolved DNS')):
            offline = BUILDER.sandbox_command(['cargo', 'build', '--offline'], state)
        self.assertIn('--unshare-net', offline)
        with tempfile.TemporaryDirectory() as name:
            resolver = Path(name) / 'resolv.conf'
            resolver.write_text('nameserver 192.0.2.53\n')
            with patch.object(BUILDER.Path, 'resolve', return_value=resolver) as resolve:
                online = BUILDER.sandbox_command(['cargo', 'fetch', '--locked'], state, network=True)
            resolve.assert_called_once_with(strict=True)
            self.assertEqual(online[-7:], ['--ro-bind', str(resolver), str(resolver), '--',
                                          'cargo', 'fetch', '--locked'])
            self.assertNotIn('--unshare-net', online)
            self.assertIn('--tmpfs', online)
            resolver.write_bytes(b'x' * (64 * 1024 + 1))
            with patch.object(BUILDER.Path, 'resolve', return_value=resolver):
                with self.assertRaises(ValueError):
                    BUILDER.sandbox_command(['cargo', 'fetch'], state, network=True)

    @unittest.skipUnless(Path('/usr/bin/bwrap').is_file(), 'requires disposable bubblewrap namespaces')
    def test_real_synthetic_run_resolver_is_read_only_and_fetch_only(self):
        # Neither sandbox has Internet access. The outer namespace supplies a
        # fake /etc -> /run resolver; the inner uses the actual builder helper.
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'etc').mkdir()
            (root / 'etc/resolv.conf').symlink_to('/run/build-resolver-test/resolv.conf')
            (root / 'resolver').write_text('nameserver 192.0.2.53\n')
            (root / 'private').write_text('unrelated-runtime-state')
            state = root / 'build'
            (state / 'source/codex-rs').mkdir(parents=True)
            probe = '''
import errno, os, sys
from pathlib import Path
resolver = Path('/etc/resolv.conf')
assert resolver.is_symlink()
assert not list(Path('/home').iterdir()) and not list(Path('/root').iterdir())
assert not Path('/run/build-private-test/token').exists()
if sys.argv[1] == 'online':
    assert resolver.read_text() == 'nameserver 192.0.2.53\\n'
    assert set(str(p) for p in Path('/run').rglob('*')) == {
        '/run/build-resolver-test', '/run/build-resolver-test/resolv.conf'}
    try:
        resolver.open('w')
    except OSError as error:
        assert error.errno == errno.EROFS
    else:
        raise AssertionError('resolver is writable')
else:
    assert not resolver.exists() and not list(Path('/run').iterdir())
    assert os.readlink('/proc/self/ns/net') != sys.argv[2]
try:
    Path('forbidden-write').write_text('x')
except OSError as error:
    assert error.errno == errno.EROFS
else:
    raise AssertionError('source is writable')
'''
            driver = '''
import importlib.util, os, subprocess, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('builder', sys.argv[1])
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
for network in (True, False):
    command = builder.sandbox_command(['/usr/bin/python3', '-I', '-c', sys.argv[3],
        'online' if network else 'offline', os.readlink('/proc/self/ns/net')],
        Path(sys.argv[2]), network=network)
    subprocess.run(command, check=True, timeout=15, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
'''
            command = ['/usr/bin/bwrap', '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/',
                       '--tmpfs', '/run', '--ro-bind', str(root / 'etc'), '/etc',
                       '--ro-bind', str(root / 'resolver'), '/run/build-resolver-test/resolv.conf',
                       '--ro-bind', str(root / 'private'), '/run/build-private-test/token',
                       '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/python3', '-I', '-c',
                       driver, str(SCRIPT), str(state), probe]
            subprocess.run(command, check=True, timeout=40,
                           env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual((root / 'resolver').read_text(), 'nameserver 192.0.2.53\n')
            self.assertEqual((root / 'private').read_text(), 'unrelated-runtime-state')
            self.assertFalse((state / 'source/codex-rs/forbidden-write').exists())

    def test_paths(self):
        for value in ('../escape', '/absolute', 'a/../b', 'a//b', 'x\\y', 'x\ny'):
            with self.assertRaises(ValueError):
                BUILDER.relative(value)
        self.assertEqual(BUILDER.relative('codex-rs/Cargo.lock'), Path('codex-rs/Cargo.lock'))

    def test_snapshot_rejects_mutated_source_and_added_files(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, destination = root / 'original', root / 'snapshot'
            source.mkdir()
            (source / 'LICENSE').write_bytes(b'original notice')
            record = {'LICENSE': dict(mode='100644', bytes=15, sha256=hashlib.sha256(b'original notice').hexdigest())}
            BUILDER.snapshot(source, destination, record)
            BUILDER.verify_snapshot(destination, record)
            (destination / 'extra').write_bytes(b'new input')
            with self.assertRaises(ValueError):
                BUILDER.verify_snapshot(destination, record)
            (destination / 'extra').unlink()
            (destination / 'LICENSE').write_bytes(b'changed notice')
            with self.assertRaises(ValueError):
                BUILDER.verify_snapshot(destination, record)

    def test_locked_sources_rejects_unpinned_git(self):
        with tempfile.TemporaryDirectory() as name:
            lock = Path(name) / 'Cargo.lock'
            lock.write_text('[[package]]\nname="x"\nversion="1"\nsource="git+https://github.com/o/r?branch=main#' + 'a' * 40 + '"\n')
            with self.assertRaises(ValueError):
                BUILDER.locked_sources(lock)
            exact = 'git+https://github.com/o/r?rev=' + 'a' * 40 + '#' + 'a' * 40
            lock.write_text('[[package]]\nname="x"\nversion="1"\nsource="' + exact + '"\n')
            self.assertEqual(BUILDER.locked_sources(lock), [exact])

    def test_registry_requires_checksum(self):
        with tempfile.TemporaryDirectory() as name:
            lock = Path(name) / 'Cargo.lock'
            source = 'registry+https://github.com/rust-lang/crates.io-index'
            lock.write_text('[[package]]\nname="x"\nversion="1"\nsource="' + source + '"\n')
            with self.assertRaises(ValueError):
                BUILDER.locked_sources(lock)
            lock.write_text(lock.read_text() + 'checksum="' + 'a' * 64 + '"\n')
            self.assertEqual(BUILDER.locked_sources(lock), [source])

    def test_only_exact_compatibility_patch_changes_snapshot(self):
        pin = json.loads(BUILDER.PIN.read_text())
        with tempfile.TemporaryDirectory() as name:
            source = Path(name)
            target = source / 'codex-rs/chatgpt/src/lib.rs'
            target.parent.mkdir(parents=True)
            data = b'pub mod apply_command;\nmod chatgpt_client;\npub mod connectors;\npub mod get_task;\n'
            target.write_bytes(data)
            records = {str(target.relative_to(source)): dict(mode='100644', bytes=len(data),
                        sha256=hashlib.sha256(data).hexdigest())}
            updated = BUILDER.patched_records(records, pin)
            BUILDER.patch_snapshot(source, records, updated, pin)
            self.assertEqual(target.read_bytes(), b'#![recursion_limit = "256"]\n\n' + data)
            with self.assertRaises(ValueError):
                BUILDER.patch_snapshot(source, records, updated, pin)


if __name__ == '__main__':
    unittest.main()
