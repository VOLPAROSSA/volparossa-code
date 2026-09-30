# SPDX-License-Identifier: GPL-3.0-only
"""Offline build-boundary tests; never execute Cargo, Codex or download data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/build_codex_runtime.py'
SPEC = importlib.util.spec_from_file_location('builder', SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BuildBoundaries(unittest.TestCase):
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
