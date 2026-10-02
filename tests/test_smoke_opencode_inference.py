# SPDX-License-Identifier: GPL-3.0-only
"""Small pure input/resource contracts, not a model, VM or runtime proof."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/smoke_opencode_inference.py'
SPEC = importlib.util.spec_from_file_location('opencode_inference_trial', SCRIPT)
TRIAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRIAL)


class Contracts(unittest.TestCase):
    def archive(self, root, name='code/example.cjs', *, payload=b'synthetic source\n', sha=None, link=False):
        manifest = dict(core_revision=TRIAL.CORE, model_profile=TRIAL.MODEL,
            code_contains_uncommitted_changes=True, code_git_head_proves_migration=False,
            files={name: dict(bytes=len(payload), sha256=sha or hashlib.sha256(payload).hexdigest(), mode=0o600)})
        path = Path(root) / 'input.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            row = tarfile.TarInfo(name)
            row.size, row.mode = len(payload), 0o600
            if link:
                row.type, row.linkname = tarfile.SYMTYPE, '/etc/passwd'
                archive.addfile(row)
            else:
                archive.addfile(row, io.BytesIO(payload))
            raw = json.dumps(manifest).encode()
            row = tarfile.TarInfo('INPUTS.json')
            row.size, row.mode = len(raw), 0o600
            archive.addfile(row, io.BytesIO(raw))
        return path

    def test_exact_synthetic_inventory_is_bound_without_clean_git_claim(self):
        with tempfile.TemporaryDirectory() as root:
            value = TRIAL.validate_bundle(self.archive(root))
            self.assertTrue(value['code_contains_uncommitted_changes'])
            self.assertFalse(value['code_git_head_proves_migration'])

    def test_changed_bytes_and_escaping_or_link_entries_are_refused(self):
        for options in ({'sha': '0' * 64}, {'name': '../outside'}, {'link': True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    TRIAL.validate_bundle(self.archive(root, **options))

    def test_memory_gate_fails_before_output_vm_or_install_actions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'build').mkdir(mode=0o700)
            output = root / 'build/never-created-opencode-memory-contract'
            args = SimpleNamespace(yes=True, output=output)
            with patch.object(TRIAL, 'ROOT', root), \
                    patch.object(TRIAL, 'available_memory', return_value=8 * TRIAL.GIB - 1), \
                    patch.object(TRIAL, 'run') as process:
                with self.assertRaisesRegex(ValueError, 'host_available_memory_below_8GiB'):
                    TRIAL.execute(args)
                process.assert_not_called()
            self.assertFalse(output.exists())

    def test_qemu_failure_is_closed_but_preserves_real_exit_and_reason(self):
        state = dict(ActiveState='failed', Result='exit-code', ExecMainCode='1', ExecMainStatus='1')
        private = b'Could not open /private/canary.img: Permission denied\n'
        observed = TRIAL.closed_qemu(state, private)
        self.assertEqual(observed['exit_code'], 1)
        self.assertIsNone(observed['signal'])
        self.assertEqual(observed['stderr_class'], 'disk_open')
        self.assertNotIn('canary', json.dumps(observed))
        self.assertEqual(TRIAL.closed_qemu(dict(state, ExecMainCode='2', ExecMainStatus='9'), b'')['signal'], 9)
        self.assertEqual(TRIAL.closed_exception(ValueError('qemu_exited'))['reason'], 'qemu_exited')
        self.assertEqual(TRIAL.closed_exception(ValueError('/private/canary'))['reason'], 'unclassified')


if __name__ == '__main__':
    unittest.main()
