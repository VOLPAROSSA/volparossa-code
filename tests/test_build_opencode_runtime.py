# SPDX-License-Identifier: GPL-3.0-only
"""Builder boundary tests; these do not claim a native source build succeeded."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import pwd
import os
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('opencode_build', ROOT / 'scripts/build_opencode_runtime.py')
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class BuildRuntimeTests(unittest.TestCase):
    def test_pins_require_exact_source_and_verified_tool(self):
        source, tool = BUILD.pins()
        self.assertEqual(source['commit'], BUILD.COMMIT)
        self.assertEqual(tool['version'], '1.3.14')
        self.assertEqual(tool['archive_bytes'], 35969274)
        self.assertEqual(len(tool['archive_sha256']), 64)

    def test_preview_does_not_prepare_or_download(self):
        output = io.StringIO()
        with patch.object(BUILD, 'prepare', side_effect=AssertionError('no prepare')), \
                patch.object(BUILD, 'fetch_tool', side_effect=AssertionError('no download')), \
                contextlib.redirect_stdout(output):
            BUILD.main([])
        value = json.loads(output.getvalue())
        self.assertIs(value['execute'], False)
        self.assertIs(value['source_build'], False)
        self.assertIs(value['global_install'], False)

    def test_build_roots_cannot_escape_ignored_scope(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(BUILD, 'ROOT', Path(directory)):
            root = Path(directory)
            allowed = root / 'build/opencode-runtime-test'
            self.assertEqual(BUILD.build_path(str(allowed)), allowed)
            for forbidden in [root, root / 'opencode-runtime', root / 'build/other',
                              root / 'build/opencode-runtime/child']:
                with self.assertRaisesRegex(ValueError, 'build-directory-scope'):
                    BUILD.build_path(str(forbidden))
            (root / 'build').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                BUILD.build_path(str(allowed))

    def test_compile_namespace_has_no_network_or_owner_home(self):
        args = BUILD.sandbox(Path('/bounded-build'), network=False)
        self.assertIn('--unshare-net', args)
        self.assertIn('--clearenv', args)
        self.assertNotIn('/etc/resolv.conf', args)
        home = pwd.getpwuid(os.getuid()).pw_dir
        self.assertEqual(args[args.index(home) - 1], '--dir')
        self.assertNotIn('HOME', args)
        self.assertIn('ALL', args)
        self.assertEqual(args.count('--bind'), 1)
        self.assertEqual(args[args.index('--bind') + 1:args.index('--bind') + 3],
                         ['/bounded-build', '/build'])
        self.assertNotIn('/etc/ssl/private', args)

    def test_fetch_namespace_keeps_credentials_absent(self):
        args = BUILD.sandbox(Path('/bounded-build'), network=True)
        self.assertNotIn('--unshare-net', args)
        self.assertIn('/etc/resolv.conf', args)
        self.assertIn('GIT_CONFIG_GLOBAL', args)
        self.assertIn('GIT_TERMINAL_PROMPT', args)
        home = pwd.getpwuid(os.getuid()).pw_dir
        self.assertEqual(args[args.index(home) - 1], '--dir')
        self.assertNotIn('HOME', args)
        self.assertNotIn('SSH_AUTH_SOCK', args)
        self.assertNotIn('GITHUB_TOKEN', args)
        self.assertNotIn('HTTP_PROXY', args)
        with self.assertRaisesRegex(ValueError, 'build-environment-scope'):
            BUILD.sandbox(Path('/bounded-build'), network=False, extra_env={'HOME': '/other'})

    def test_failed_compile_cannot_emit_success_report(self):
        source, tool = BUILD.pins()
        calls = []

        def controlled_stage(build, name, command, **options):
            calls.append((name, command, options))
            if name == 'source-diff':
                return BUILD.CONFIG + '\n'
            if name == 'compile':
                raise ValueError('intentional-compile-failure')
            return ''

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(BUILD, 'run', side_effect=controlled_stage), \
                patch.object(BUILD, 'source_checks'):
            target = Path(directory)
            with self.assertRaisesRegex(ValueError, 'intentional-compile-failure'):
                BUILD.build_runtime(target, source, tool, target / 'bun')
            self.assertFalse((target / 'build-report.json').exists())
        dependencies = next(call for call in calls if call[0] == 'dependencies')
        self.assertEqual(dependencies[1], ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'])
        self.assertIs(dependencies[2]['network'], True)
        compile_step = next(call for call in calls if call[0] == 'compile')
        self.assertNotIn('network', compile_step[2])  # run() defaults to no network.
        self.assertIn('--skip-install', compile_step[1])
        self.assertIn('--skip-embed-web-ui', compile_step[1])
        self.assertNotIn('OPENCODE_RELEASE', compile_step[2]['extra_env'])
        self.assertEqual(compile_step[2]['extra_env']['OPENCODE_VERSION'], '1.18.34')
        self.assertEqual(compile_step[2]['extra_env']['MODELS_DEV_API_JSON'], '/build/models.json')

    def test_patched_source_binding_detects_extra_config_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            source = target / 'source'
            config = source / BUILD.CONFIG
            config.parent.mkdir(parents=True)
            (source / 'bun.lock').write_text('lock')
            (source / 'LICENSE').write_text('license')
            (source / 'package.json').write_text('{"packageManager":"bun@1.3.14"}')
            (source / 'packages/opencode/package.json').write_text('{"version":"1.18.34"}')
            config.write_text('reviewed patch result')
            BUILD.write_json(target / 'prepared.json', {'patched_config_sha256': BUILD.digest(config)})
            pin = {'bun_lock_sha256': BUILD.digest(source / 'bun.lock'),
                   'license_sha256': BUILD.digest(source / 'LICENSE'), 'bun': '1.3.14', 'tag': 'v1.18.34'}
            BUILD.source_checks(target, pin, patched=True)
            config.write_text('additional source modification')
            with self.assertRaisesRegex(ValueError, 'patched-source-config-pin'):
                BUILD.source_checks(target, pin, patched=True)

    def test_generated_records_are_exclusive_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'record.json'
            BUILD.write_json(record, {'source_build': False})
            self.assertEqual(record.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                BUILD.write_json(record, {'source_build': True})
            self.assertIs(BUILD.load(record)['source_build'], False)


if __name__ == '__main__':
    unittest.main()
