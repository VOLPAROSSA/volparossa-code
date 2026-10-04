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
    def archive(self, root, name='code/example.cjs', *, payload=b'synthetic source\n', sha=None, link=False,
                model_profile=TRIAL.MODEL, core_revision=None):
        manifest = dict(core_revision=core_revision or TRIAL.trial_profile(model_profile)['core_revision'], model_profile=model_profile,
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

    def test_profiles_are_closed_and_default_resources_are_unchanged(self):
        self.assertEqual(TRIAL.trial_profile(), dict(model_profile='qwen3-0.6b-v1',
            core_revision='845cc84d0d0b766ab1c5227231dbf6c8eaeb8cc3', guest_memory_mib=6144,
            core_memory_bytes=5 * TRIAL.GIB, qemu_memory_bytes=7 * TRIAL.GIB,
            host_available_bytes=8 * TRIAL.GIB, provision_budget_bytes=5 * TRIAL.GIB,
            scratch_gib=18, memory_failure='host_available_memory_below_8GiB'))
        for profile in ('other', '', 'qwen3-4b-v1', None, 'qwen3-0.6b-v1;echo bad'):
            with self.subTest(profile=profile), self.assertRaisesRegex(ValueError, 'unknown_model_profile'):
                TRIAL.trial_profile(profile)

    def test_larger_profile_is_separate_and_requires_a_real_pin(self):
        self.assertRegex(TRIAL.LARGE_CORE, r'^[0-9a-f]{40}$')
        self.assertNotEqual(TRIAL.LARGE_CORE, TRIAL.CORE)
        with patch.object(TRIAL, 'LARGE_CORE', None):
            with self.assertRaisesRegex(ValueError, 'larger_core_not_pinned'):
                TRIAL.trial_profile(TRIAL.LARGE_MODEL)
        with patch.object(TRIAL, 'LARGE_CORE', 'a' * 40):
            profile = TRIAL.trial_profile(TRIAL.LARGE_MODEL)
            self.assertEqual(profile['guest_memory_mib'], 12 * 1024)
            self.assertEqual(profile['core_memory_bytes'], 11 * TRIAL.GIB)
            self.assertEqual(profile['qemu_memory_bytes'], 13 * TRIAL.GIB)
            self.assertEqual(profile['host_available_bytes'], 14 * TRIAL.GIB)
            self.assertEqual(profile['provision_budget_bytes'], 20 * TRIAL.GIB)
            self.assertEqual(profile['scratch_gib'], 40)
            self.assertEqual(TRIAL.trial_profile()['core_revision'], TRIAL.CORE)

    def test_bundle_profile_and_core_cannot_be_substituted_or_implicitly_upgraded(self):
        with patch.object(TRIAL, 'LARGE_CORE', 'a' * 40):
            for requested, bundled, core, accepted in (
                (TRIAL.LARGE_MODEL, TRIAL.LARGE_MODEL, 'a' * 40, True),
                (TRIAL.MODEL, TRIAL.LARGE_MODEL, 'a' * 40, False),
                (TRIAL.LARGE_MODEL, TRIAL.MODEL, TRIAL.CORE, False),
                (TRIAL.LARGE_MODEL, TRIAL.LARGE_MODEL, TRIAL.CORE, False),
                (TRIAL.MODEL, TRIAL.MODEL, 'a' * 40, False),
            ):
                with self.subTest(requested=requested, bundled=bundled, core=core), tempfile.TemporaryDirectory() as root:
                    path = self.archive(root, model_profile=bundled, core_revision=core)
                    if accepted:
                        self.assertEqual(TRIAL.validate_bundle(path, requested)['model_profile'], requested)
                    else:
                        with self.assertRaisesRegex(ValueError, 'bundle_authority'):
                            TRIAL.validate_bundle(path, requested)

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

    def test_larger_memory_gate_does_not_borrow_default_budget_or_start_anything(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'LARGE_CORE', 'a' * 40):
            root = Path(temp)
            (root / 'build').mkdir(mode=0o700)
            output = root / 'build/unstarted-larger-trial'
            args = SimpleNamespace(yes=True, output=output, model_profile=TRIAL.LARGE_MODEL)
            with patch.object(TRIAL, 'ROOT', root), \
                    patch.object(TRIAL, 'available_memory', return_value=14 * TRIAL.GIB - 1), \
                    patch.object(TRIAL, 'run') as process:
                with self.assertRaisesRegex(ValueError, 'host_available_memory_below_14GiB'):
                    TRIAL.execute(args)
                process.assert_not_called()
            self.assertFalse(output.exists())

    def test_memory_admission_checks_total_and_available_without_swap(self):
        for total, available, expected in ((16, 13, 13), (13, 16, 13), (16, 14, 14)):
            contents = f'MemTotal: {total * 1024**2} kB\nMemAvailable: {available * 1024**2} kB\nSwapFree: 999999999 kB\n'
            with self.subTest(total=total, available=available), patch.object(Path, 'read_text', return_value=contents):
                self.assertEqual(TRIAL.available_memory(), expected * TRIAL.GIB)

    def test_larger_qemu_changes_memory_only_not_cpus_network_or_isolation(self):
        with patch.object(TRIAL, 'LARGE_CORE', 'a' * 40):
            default = TRIAL.qemu_command(Path('/verified/tools'), Path('/private/scratch'))
            larger = TRIAL.qemu_command(Path('/verified/tools'), Path('/private/scratch'),
                                       model_profile=TRIAL.LARGE_MODEL)
            changed = [(index, left, right) for index, (left, right) in enumerate(zip(default, larger)) if left != right]
            self.assertEqual(changed, [(default.index('-m') + 1, '6144', '12288')])
            self.assertEqual(len(default), len(larger))

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

    def provision_log(self, root, content):
        path = Path(root) / 'private-provision.log'
        path.write_bytes(content)
        path.chmod(0o600)
        return path

    def test_provision_progress_is_exact_pin_order_not_download_completion(self):
        pins = dict(wheels=[dict(path='public-wheel.whl', bytes=20)],
                    files=[dict(path='public-shard.safetensors', bytes=40)])
        raw = b'{"downloading": "public-wheel.whl", "bytes": 20}\n' \
              b'{"downloading": "public-shard.safetensors", "bytes": 40}\n' \
              b'Provisioning refused: download size header mismatch\n'
        with tempfile.TemporaryDirectory() as root:
            result = TRIAL.closed_provision(self.provision_log(root, raw), pins, 'process', 1)
        self.assertEqual(result['download_starts'], 2)
        self.assertEqual(result['last_artifact_index'], 1)
        self.assertEqual(result['progress_state'], 'ordered')
        self.assertEqual(result['failure_class'], 'download_length')
        self.assertEqual(result['process_status'], 1)
        self.assertEqual(result['stage'], 'process')
        self.assertNotIn('public-shard', json.dumps(result))
        self.assertNotIn('downloads_complete', result)

    def test_provision_rejects_unknown_duplicate_reordered_or_wrong_size_progress(self):
        pins = dict(wheels=[dict(path='first.whl', bytes=20)], files=[dict(path='second.bin', bytes=40)])
        first = b'{"downloading": "first.whl", "bytes": 20}\n'
        for raw in (b'{"downloading": "private-canary", "bytes": 20}\n',
                    b'{"downloading": "second.bin", "bytes": 40}\n',
                    b'{"downloading": "first.whl", "bytes": 21}\n', first + first,
                    b'{"downloading": "first.whl", "bytes": 20, "secret": "private-canary"}\n',
                    b'{"downloading": invalid-json\n'):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as root:
                result = TRIAL.closed_provision(self.provision_log(root, raw), pins, 'process', 1)
                self.assertEqual(result['progress_state'], 'invalid')
                self.assertLessEqual(result['download_starts'], 1)
                self.assertNotIn('private-canary', json.dumps(result))

    def test_provision_error_classes_never_export_raw_urls_paths_or_subprocess_commands(self):
        for raw, category in (
            (b'free disk space is below the explicit budget', 'free_disk_budget'),
            (b'verified wheel expansion exceeds explicit disk budget', 'wheel_expansion_budget'),
            (b'unapproved artifact URL/redirect', 'redirect_refused'),
            (b'HTTP Error 403: https://private-canary.invalid/token=secret', 'http'),
            (b'<urlopen error private-canary>', 'network'),
            (b'[Errno 28] No space left on device: /private-canary', 'disk_full'),
            (b'Command [private-canary] returned non-zero exit status 1.', 'runtime_subprocess'),
            (b'The read operation timed out', 'network_timeout'),
            (b'private-canary unexpected error', 'other_refusal'),
        ):
            with self.subTest(category=category), tempfile.TemporaryDirectory() as root:
                path = self.provision_log(root, b'Provisioning refused: ' + raw + b'\n')
                result = TRIAL.closed_provision(path, dict(wheels=[], files=[]), 'process', 1)
                self.assertEqual(result['failure_class'], category)
                self.assertNotIn('private-canary', json.dumps(result))
                self.assertNotIn('token', json.dumps(result))

    def test_provision_retains_only_valid_numeric_http_status(self):
        for raw, expected in ((b'HTTP Error 403: private-canary', 403),
                              (b'HTTP Error 429: private-canary', 429),
                              (b'HTTP Error 503: private-canary', 503),
                              (b'HTTP Error 99: private-canary', None),
                              (b'HTTP Error 600: private-canary', None),
                              (b'HTTP Error 4030: private-canary', None),
                              (b'private-canary HTTP Error 403:', None)):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as root:
                path = self.provision_log(root, b'Provisioning refused: ' + raw + b'\n')
                result = TRIAL.closed_provision(path, None, 'process', 1)
                self.assertEqual(result['http_status'], expected)
                self.assertNotIn('private-canary', json.dumps(result))

    def test_provision_steps_distinguish_report_and_provenance_without_accepting_a_model(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.provision_log(root, b'PINNED_WHEEL_GRAPH_OK\nOFFLINE_CPU_RUNTIME_IMPORT_OK\n')
            for stage in ('report', 'provenance', 'complete'):
                result = TRIAL.closed_provision(path, dict(wheels=[], files=[]), stage, 0)
                self.assertEqual(result['stage'], stage)
                self.assertEqual(result['process_status'], 0)
                self.assertTrue(result['wheel_graph_checked'])
                self.assertTrue(result['runtime_import_checked'])
                self.assertNotIn('actual_model_provisioned', result)
            result = TRIAL.closed_provision(path, None, 'private-canary', 999, True)
            self.assertEqual(result['stage'], 'unknown')
            self.assertIsNone(result['process_status'])
            self.assertTrue(result['wait_timeout'])

    def test_provision_log_read_is_bounded_and_does_not_follow_links_or_nonfiles(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.provision_log(root, b'PINNED_WHEEL_GRAPH_OK\n' + b'x' * 131073)
            result = TRIAL.closed_provision(path, None, 'process', -9)
            self.assertEqual(result['log_state'], 'truncated')
            self.assertFalse(result['wheel_graph_checked'])
            self.assertEqual(result['failure_class'], 'unknown')
            link = Path(root) / 'link'
            link.symlink_to(path)
            self.assertEqual(TRIAL.closed_provision(link, None, 'process', 1)['log_state'], 'invalid')
            path.chmod(0o644)
            self.assertEqual(TRIAL.closed_provision(path, None, 'process', 1)['log_state'], 'invalid')
            self.assertEqual(TRIAL.closed_provision(Path(root), None, 'process', 1)['log_state'], 'invalid')
            self.assertEqual(TRIAL.closed_provision(Path(root) / 'missing', None, 'launch', None)['log_state'], 'absent')

    def test_headless_guest_retains_verified_vga_and_live_pid_without_more_resources(self):
        args = TRIAL.qemu_command(Path('/verified/tools'), Path('/new/private/scratch'))
        self.assertIn('VGA,id=video0,bus=pcie.0,addr=0x1,romfile=/verified/tools/root/usr/share/seabios/vgabios-stdvga.bin', args)
        self.assertEqual(args[args.index('-display') + 1], 'none')
        self.assertEqual(args[args.index('-m') + 1], '6144')
        self.assertEqual(args[args.index('-smp') + 1], '2')
        self.assertIn('-no-reboot', args)
        self.assertFalse(TRIAL.boot_running(dict(ActiveState='active', MainPID='0')))
        self.assertFalse(TRIAL.boot_running(dict(ActiveState='failed', MainPID='123')))
        self.assertTrue(TRIAL.boot_running(dict(ActiveState='active', MainPID='123')))


if __name__ == '__main__':
    unittest.main()
