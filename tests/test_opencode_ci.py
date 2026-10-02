# SPDX-License-Identifier: GPL-3.0-only
"""Offline wiring/admission contracts, not a hosted runner or model proof."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


CI = load('opencode_ci')
TRIAL = load('smoke_opencode_inference')


class Contracts(unittest.TestCase):
    def test_host_profile_is_explicit_and_refused_on_local_host(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'hosted_ci_only'):
                CI.verify_host_tools(Path('/usr'))
            process.assert_not_called()
        with patch.object(CI, 'guard'), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'ci_system_tools_only'):
                CI.verify_host_tools(Path('/untrusted/tools'))
            process.assert_not_called()

    def test_hosted_memory_gate_precedes_any_service_or_vm(self):
        with patch.object(CI, 'verify_host_tools', return_value={}), \
                patch.object(CI, 'module', return_value=SimpleNamespace(GIB=TRIAL.GIB,
                    available_memory=lambda: 8 * TRIAL.GIB - 1)), patch.object(CI, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'host_available_memory_below_8GiB'):
                CI.preflight()
            process.assert_not_called()

    def test_actual_service_probe_demands_kvm_and_effective_cgroup_limits(self):
        calls = []

        def process(args, **kwargs):
            calls.append(args)
            output = 'MainPID=0\nActiveState=inactive\n' if 'show' in args else ''
            return subprocess.CompletedProcess(args, 0, output, '')

        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), \
                patch.object(CI, 'verify_host_tools', return_value={'profile': CI.PROFILE}), \
                patch.object(CI, 'module', return_value=SimpleNamespace(GIB=TRIAL.GIB,
                    available_memory=lambda: 8 * TRIAL.GIB)), patch.object(CI.subprocess, 'run', side_effect=process):
            CI.preflight()
            command = next(args for args in calls if args[0] == 'systemd-run')
            self.assertIn('--user', command)
            self.assertIn('--property=MemoryMax=' + str(7 * TRIAL.GIB), command)
            self.assertIn('--property=MemorySwapMax=0', command)
            probe = command[command.index('-c') + 1]
            for bound in ('0xAE00', "'/user.slice/'", "'memory.max'", "'memory.swap.max'"):
                self.assertIn(bound, probe)
            self.assertTrue(json.loads((Path(tmp) / 'ci-preflight.json').read_text())['preflight_service_joined'])

    def test_ubuntu_qemu_changes_only_verified_tool_and_firmware_paths(self):
        original = TRIAL.qemu_command(Path('/verified/tools'), Path('/private/scratch'))
        hosted = TRIAL.qemu_command(Path('/usr'), Path('/private/scratch'),
                                    Path('/usr/share/seabios/vgabios-stdvga.bin'))
        firmware_index = original.index('-device') + 1
        self.assertEqual([arg for index, arg in enumerate(original) if index not in (0, firmware_index)],
                         [arg for index, arg in enumerate(hosted) if index not in (0, firmware_index)])
        self.assertEqual(hosted[0], Path('/usr/bin/qemu-system-x86_64'))
        self.assertIn('VGA,id=video0,bus=pcie.0,addr=0x1,romfile=/usr/share/seabios/vgabios-stdvga.bin', hosted)
        self.assertEqual(hosted[hosted.index('-m') + 1], '6144')
        self.assertEqual(hosted[hosted.index('-smp') + 1], '2')

    def test_fixed_receipt_export_does_not_publish_private_sentinels(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(CI, 'BUILD', Path(tmp)), patch.object(CI, 'guard'):
            root = Path(tmp)
            (root / 'ci-vm').mkdir()
            CI.record(root / 'ci-source.json', {'version': 1, 'code_revision': 'a' * 40})
            CI.record(root / 'ci-vm/vm-result.json', {'passed': False, 'qemu_joined': True})
            for name in ('ssh-key', 'console.log', 'task.json', 'ci-inputs.tar.gz'):
                (root / name).write_text('private sentinel')
            CI.export()
            result = root / 'ci-public-receipts'
            self.assertEqual({p.name for p in result.iterdir()}, {'ci-source.json', 'vm-result.json'})
            self.assertNotIn('sentinel', ''.join(p.read_text() for p in result.iterdir()))

    def test_guest_function_remains_identical_to_reviewed_baseline(self):
        # Exact reviewed afdb284 guest AST, also usable in shallow source CI.
        current = (ROOT / 'scripts/smoke_opencode_inference.py').read_text()
        def guest(source):
            return ast.dump(next(node for node in ast.parse(source).body
                                 if isinstance(node, ast.FunctionDef) and node.name == 'guest'))
        self.assertEqual(hashlib.sha256(guest(current).encode()).hexdigest(),
                         'fcaf7eae53c1aeb842e3d5a07fd9c13ca0b80026243dbb8d0752f7e38a5f43e4')

    def test_workflow_has_one_manual_trial_and_closed_export_only(self):
        source = (ROOT / '.github/workflows/opencode-inference.yml').read_text()
        for required in ('workflow_dispatch:', 'cancel-in-progress: false', 'runs-on: ubuntu-24.04',
                         CI.CORE, 'persist-credentials: false', '--host-tools-profile github-ubuntu-24.04',
                         'env -i PATH=/usr/bin:/bin', 'build/ci-public-receipts/*.json'):
            self.assertIn(required, source)
        for forbidden in ('pull_request:', '\n  push:', 'actions/cache', 'upload-artifact@main',
                          'sysctl -w', '--no-sandbox', 'continue-on-error:', '--resume'):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count('smoke_opencode_inference.py execute --yes'), 1)


if __name__ == '__main__':
    unittest.main()
