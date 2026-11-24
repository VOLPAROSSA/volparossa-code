# SPDX-License-Identifier: GPL-3.0-only
"""Offline public Code CI wiring; no VM, peer, model or external tool execution."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('public_code_ci', ROOT / 'scripts/public_code_ci.py')
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)


class Contracts(unittest.TestCase):
    def test_hosted_guard_and_missing_core_pin_fail_before_execution(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'hosted_ci_only'):
                CI.main(['guard'])
        for invalid in (None, '', 'main', 'a' * 39):
            with patch.object(CI, 'CORE', invalid), self.assertRaisesRegex(ValueError, 'core_fixture_not_pinned'):
                CI.core_pin()

    def test_workbench_pins_are_separate_and_unknown_frontends_are_rejected(self):
        with patch.dict(os.environ, {'VOLPAROSSA_PUBLIC_WORKBENCH': 'true'}):
            self.assertEqual(CI.core_pin(), CI.WORKBENCH_CORE)
            self.assertEqual(CI.driver_source(), (CI.WORKBENCH_DRIVER, CI.WORKBENCH_TREE))
        with patch.dict(os.environ, {'VOLPAROSSA_PUBLIC_WORKBENCH': 'arbitrary'}), self.assertRaises(ValueError):
            CI.driver_source()

    def test_source_binds_different_workflow_and_driver_commits_without_branch_substitution(self):
        workflow, core_revision = 'a' * 40, 'b' * 40
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / 'build/public-code-core'
            core.mkdir(parents=True)

            def run(args, **unused):
                calls.append(args)
                repository, command = args[2], args[3:]
                output = ''
                if command == ['rev-parse', 'HEAD']:
                    output = workflow if repository == root else core_revision
                elif command == ['rev-parse', CI.DRIVER + '^{tree}']:
                    output = CI.DRIVER_TREE
                elif command == ['rev-parse', 'HEAD^{tree}']:
                    output = 'd' * 40
                return SimpleNamespace(stdout=output)

            shared = SimpleNamespace(guard=Mock(), run=run, record=Mock())
            with patch.object(CI, 'ROOT', root), patch.object(CI, 'BUILD', root / 'build'), \
                    patch.object(CI, 'CORE', core_revision), patch.object(CI, 'ci', return_value=shared), \
                    patch.object(CI, 'fixture', return_value={'CODE_REVISION': CI.DRIVER, 'PROFILE': CI.MODEL}), \
                    patch.dict(os.environ, {'GITHUB_SHA': workflow}):
                result = CI.sources(workflow)
                self.assertEqual(result['workflow_code_revision'], workflow)
                self.assertEqual(result['driver_code_revision'], CI.DRIVER)
                self.assertNotEqual(result['workflow_code_revision'], result['driver_code_revision'])
                self.assertIn(['git', '-C', root, 'merge-base', '--is-ancestor', CI.DRIVER, workflow], calls)
                with self.assertRaisesRegex(ValueError, 'exact_workflow_source'):
                    CI.sources(CI.DRIVER)

    def test_planner_checks_inherited_and_overridden_editor_source_blobs_before_build(self):
        capture = CI.module(ROOT / 'scripts/pack_opencode_cooperation.py', 'public_ci_pack')
        common, changed = b'common', b'planner'
        actual = {'code/a': common, 'code/b': changed}
        pin = lambda data: dict(bytes=len(data), sha256=capture.sha(data))
        catalog = {'WORKBENCH': {'files': {'code/a': pin(common), 'code/b': pin(b'previous')}},
                   'PLANNER': {'files': {'code/b': pin(changed)}}}
        with patch.object(CI, 'module', return_value=capture), patch.object(capture, 'blobs', return_value=actual):
            CI.verify_workbench_sources(catalog, CI.PLANNER_DRIVER, True)
            del catalog['PLANNER']['files']['code/b']
            with self.assertRaisesRegex(ValueError, 'workbench_source_inventory'):
                CI.verify_workbench_sources(catalog, CI.PLANNER_DRIVER, True)

    def test_pack_uses_immutable_driver_and_core_validator_not_current_workflow_as_fixture_source(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(CI, 'BUILD', Path(directory)), \
                patch.object(CI, 'CORE', 'b' * 40), patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}), \
                patch.object(CI, 'ci', return_value=SimpleNamespace(guard=Mock(), record=Mock())):
            root = Path(directory)
            (root / 'public-code-source.json').write_text(json.dumps(dict(workflow_code_revision='a' * 40,
                core_revision='b' * 40, driver_code_revision=CI.DRIVER, driver_code_tree=CI.DRIVER_TREE)))
            bundle = root / 'public-code-proposal-inputs-ci'
            bundle.mkdir()
            manifest = {'kind': 'contract-only'}
            (bundle / 'INPUTS.json').write_text(json.dumps(manifest))
            capture = SimpleNamespace(pack_proposal=Mock(return_value={'manifest_sha256': 'd' * 64}))
            validate = Mock()
            with patch.object(CI, 'module', return_value=capture), \
                    patch.object(CI, 'fixture', return_value={'bundle_manifest': validate}):
                CI.pack()
            args = capture.pack_proposal.call_args.args[0]
            self.assertEqual(args.code_revision, CI.DRIVER)
            self.assertEqual(args.node, root / 'public-code-node/bin/node')
            self.assertFalse(hasattr(args, 'build_report'))
            validate.assert_called_once_with(manifest)

    def test_gate_preserves_original_core_check_and_never_ignores_runner_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(CI, 'BUILD', Path(directory)), \
                patch.object(CI, 'CORE', 'b' * 40), patch.object(CI, 'output_path', return_value=Path(directory)), \
                patch.object(CI, 'ci', return_value=SimpleNamespace(guard=Mock())):
            root = Path(directory)
            status = dict(version=1, core_revision='b' * 40, scenario=CI.SCENARIO, exit_status=0,
                native_editor_ui_proven=False, private_opencode_planner_proven=False)
            file = root / 'public-code-runner.json'
            file.write_text(json.dumps(status))
            (root / (CI.SCENARIO + '-smoke.json')).write_text('{"original":"core report"}')
            validate = Mock()
            with patch.object(CI, 'fixture', return_value={'check_report': validate}):
                CI.gate()
                validate.assert_called_once_with({'original': 'core report'}, 'b' * 40)
                status['exit_status'] = 1
                file.write_text(json.dumps(status))
                with self.assertRaisesRegex(ValueError, 'runner_did_not_pass'):
                    CI.gate()
                self.assertEqual(validate.call_count, 1)

    def test_planner_requires_workbench_and_uses_its_distinct_immutable_sources(self):
        with patch.dict(os.environ, {'VOLPAROSSA_PUBLIC_PLANNER':'true','VOLPAROSSA_PUBLIC_WORKBENCH':'false'}):
            with self.assertRaises(ValueError):
                CI.driver_source()
        with patch.dict(os.environ, {'VOLPAROSSA_PUBLIC_PLANNER':'true','VOLPAROSSA_PUBLIC_WORKBENCH':'true'}):
            self.assertEqual(CI.driver_source(), (CI.PLANNER_DRIVER, CI.PLANNER_TREE))
            self.assertEqual(CI.core_pin(), CI.PLANNER_CORE)

    def test_export_uses_closed_fixed_producers_and_keeps_raw_logs_out(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(CI, 'BUILD', Path(directory)), \
                patch.object(CI, 'ci', return_value=SimpleNamespace(guard=Mock())):
            root = Path(directory)
            output = root / 'guest'
            output.mkdir()
            for file in (root / 'public-code-source.json', output / 'agent-cooperative-code-proposal-driver.json'):
                file.write_text('{"version":1,"passed":false}')
                file.chmod(0o600)
            for name in ('report.private', 'report_json', 'vm-console.log', 'qemu.stderr', 'model.safetensors', 'image.qcow2'):
                (output / name).write_text('private sentinel')
            with patch.object(CI, 'output_path', return_value=output), \
                    patch.object(CI, 'fixture', return_value={'EXPORT_NAMES': ('agent-cooperative-code-proposal-driver.json',)}):
                CI.export()
            exported = root / 'public-code-receipts'
            self.assertEqual({file.name for file in exported.iterdir()},
                {'public-code-source.json', 'agent-cooperative-code-proposal-driver.json'})
            self.assertNotIn('sentinel', ''.join(file.read_text() for file in exported.iterdir()))

    def test_receipt_symlinks_hardlinks_and_wide_modes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.write_text('{}')
            source.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'closed_receipt_file'):
                CI.copy_receipt(source, root / 'result')
            source.chmod(0o600)
            (root / 'symlink').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'closed_receipt_file'):
                CI.copy_receipt(root / 'symlink', root / 'result')
            os.link(source, root / 'hardlink')
            with self.assertRaisesRegex(ValueError, 'closed_receipt_file'):
                CI.copy_receipt(source, root / 'result')
            self.assertFalse((root / 'result').exists())

    def test_workflow_has_one_core_runner_and_only_builds_opencode_for_the_explicit_planner(self):
        workflow = (ROOT / '.github/workflows/opencode-public-code.yml').read_text()
        for fragment in ('workflow_dispatch:', 'expected_code_sha:', 'cancel-in-progress: false',
                'persist-credentials: false', 'contents: read', 'timeout-minutes: 120',
                '--no-new-privs --reset-env', '--scenario agent-cooperative-code-proposal',
                'public_code_ci.py gate', 'build/public-code-receipts/*.json'):
            self.assertIn(fragment, workflow)
        self.assertEqual(workflow.count('run-alpha-topology-vm.sh'), 1)
        build_step = workflow.split('- name: Source-build OpenCode', 1)[1].split('- name:', 1)[0]
        self.assertIn('if: inputs.local_opencode_planner', build_step)
        self.assertIn('bash scripts/opencode_ci_build.sh', build_step)
        self.assertEqual(workflow.count('bash scripts/opencode_ci_build.sh'), 1)
        for forbidden in ('smoke_opencode_inference.py execute', 'build_opencode_runtime.py',
                          'runtime/opencode', 'ACTIONS_RUNTIME_TOKEN', 'curl |', 'pull_request:'):
            self.assertNotIn(forbidden, workflow)
        self.assertLess(workflow.index('public_code_ci.py source'), workflow.index('Prepare the signed Ubuntu archive'))
        # Parse just literal run blocks as shell; no workflow/tool action runs.
        lines = workflow.splitlines()
        for index, line in enumerate(lines):
            if line.strip() != 'run: |':
                continue
            selected = []
            for child in lines[index + 1:]:
                if child and not child.startswith('          '):
                    break
                selected.append(child[10:])
            checked = subprocess.run(['bash', '-n'], input='\n'.join(selected), text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == '__main__':
    unittest.main()
