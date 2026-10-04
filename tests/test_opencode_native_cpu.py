# SPDX-License-Identifier: GPL-3.0-only
"""Inert native fixture bindings; no source fetch, build, library or model load."""
import hashlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
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


NATIVE = load('opencode_native_cpu')
TRIAL = load('smoke_opencode_inference')
CI = load('opencode_ci')
KIND = 'llama_cpp_bf16_v1'


class Contracts(unittest.TestCase):
    def test_native_is_refused_without_final_pin_and_cannot_replace_default(self):
        self.assertEqual(TRIAL.NATIVE_CORE, '7308371b20ced0504662178beb0e46586cfc9d2d')
        original = TRIAL.trial_profile(TRIAL.LARGE_MODEL)
        self.assertNotIn('inference_backend', original)
        with patch.object(TRIAL, 'NATIVE_CORE', None), self.assertRaisesRegex(ValueError, 'native_core_not_pinned'):
            TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
        for model in (TRIAL.MODEL,):
            with self.assertRaisesRegex(ValueError, 'native_backend_requires_qwen4b'):
                TRIAL.trial_profile(model, KIND)
        for backend in (None, '', 'llama_cpp', 'torch;id'):
            with self.assertRaisesRegex(ValueError, 'unknown_inference_backend'):
                TRIAL.trial_profile(TRIAL.LARGE_MODEL, backend)
        # Synthetic pin tests selection only; no invented production pin is set.
        with patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            native = TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
            self.assertEqual({k: v for k, v in native.items() if k not in
                              ('core_revision', 'inference_backend', 'native_source_commit')},
                             {k: v for k, v in original.items() if k != 'core_revision'})
            self.assertEqual(native['native_source_commit'], NATIVE.SOURCE)
            self.assertEqual(TRIAL.trial_profile(TRIAL.LARGE_MODEL), original)
            old = TRIAL.qemu_command(Path('/tools'), Path('/scratch'), model_profile=TRIAL.LARGE_MODEL)
            new = TRIAL.qemu_command(Path('/tools'), Path('/scratch'), model_profile=TRIAL.LARGE_MODEL,
                                     inference_backend=KIND)
            self.assertEqual(old, new)

    def test_backend_metadata_cannot_be_missing_partial_or_implicitly_added(self):
        with patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            profile = TRIAL.trial_profile(TRIAL.LARGE_MODEL, KIND)
        exact = {'inference_backend': KIND, 'native_source_commit': NATIVE.SOURCE}
        TRIAL.validate_backend_fields(exact, profile)
        self.assertEqual(CI.backend_fields(profile), exact)
        for value in ({}, {'inference_backend': KIND}, {'native_source_commit': NATIVE.SOURCE},
                      dict(exact, inference_backend='torch'), dict(exact, native_source_commit='0' * 40)):
            with self.assertRaisesRegex(ValueError, 'input_backend'):
                TRIAL.validate_backend_fields(value, profile)
        for value in (exact, {'inference_backend': None}):
            with self.assertRaisesRegex(ValueError, 'input_backend'):
                TRIAL.validate_backend_fields(value, TRIAL.trial_profile())

    def test_real_bundle_and_staging_parsers_reject_native_source_substitution(self):
        payload = b'inert input bytes, no runtime or model'
        row = dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(), mode=0o600)
        exact = dict(core_revision='a' * 40, model_profile=TRIAL.LARGE_MODEL,
                     inference_backend=KIND, native_source_commit=NATIVE.SOURCE,
                     code_contains_uncommitted_changes=True, code_git_head_proves_migration=False,
                     files={'code/example.cjs': row})
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40):
            root = Path(temp)
            (root / 'code').mkdir()
            (root / 'code/example.cjs').write_bytes(payload)
            (root / 'code/example.cjs').chmod(0o600)
            for value, accepted in ((exact, True), (dict(exact, core_revision='b' * 40), False),
                                    (dict(exact, model_profile=TRIAL.MODEL), False),
                                    (dict(exact, inference_backend='torch'), False),
                                    (dict(exact, native_source_commit='b' * 40), False),
                                    ({key: val for key, val in exact.items()
                                      if key != 'native_source_commit'}, False)):
                raw = json.dumps(value).encode()
                path = root / 'inputs.tar.gz'
                with tarfile.open(path, 'w:gz') as archive:
                    for name, content in (('code/example.cjs', payload), ('INPUTS.json', raw)):
                        entry = tarfile.TarInfo(name)
                        entry.mode, entry.size = 0o600, len(content)
                        archive.addfile(entry, io.BytesIO(content))
                (root / 'INPUTS.json').write_bytes(raw)
                with self.subTest(value=value), patch.object(TRIAL, 'INPUT', root):
                    for parse in (lambda: TRIAL.validate_bundle(path, TRIAL.LARGE_MODEL, KIND),
                                  lambda: TRIAL.staged_inputs(TRIAL.LARGE_MODEL, KIND)):
                        if accepted:
                            self.assertEqual(parse(), exact)
                        else:
                            with self.assertRaises(ValueError):
                                parse()

    def test_ci_capture_binds_same_backend_and_rejects_mixed_source_receipts(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'NATIVE_CORE', 'a' * 40), \
                patch.object(CI, 'BUILD', Path(temp)), patch.object(CI, 'guard'), \
                patch.object(CI, 'module', return_value=TRIAL), \
                patch.dict(os.environ, {'GITHUB_SHA': 'c' * 40}):
            root = Path(temp)
            manifest = dict(code_base_revision='c' * 40, core_revision='a' * 40,
                            model_profile=TRIAL.LARGE_MODEL, inference_backend=KIND,
                            native_source_commit=NATIVE.SOURCE)
            source = dict(manifest, code_revision='c' * 40)
            (root / 'ci-source.json').write_text(json.dumps(source))
            (root / 'ci-inputs.tar.gz').write_bytes(b'inert bundle, parser checked separately')
            with patch.object(TRIAL, 'validate_bundle', return_value=manifest) as parser:
                CI.capture(TRIAL.LARGE_MODEL, KIND)
                parser.assert_called_once_with(root / 'ci-inputs.tar.gz', TRIAL.LARGE_MODEL, KIND)
                captured = json.loads((root / 'ci-inputs.json').read_text())
                self.assertEqual(captured['inference_backend'], KIND)
                self.assertEqual(captured['native_source_commit'], NATIVE.SOURCE)
                (root / 'ci-source.json').write_text(json.dumps(dict(source, inference_backend='torch')))
                with self.assertRaisesRegex(ValueError, 'input_backend'):
                    CI.capture(TRIAL.LARGE_MODEL, KIND)

    def test_native_missing_pin_stops_before_memory_tools_or_vm(self):
        with patch.object(TRIAL, 'NATIVE_CORE', None), patch.object(TRIAL, 'run') as process, \
                patch.object(TRIAL, 'available_memory') as memory:
            with self.assertRaisesRegex(ValueError, 'native_core_not_pinned'):
                TRIAL.execute(SimpleNamespace(model_profile=TRIAL.LARGE_MODEL, inference_backend=KIND))
            process.assert_not_called()
            memory.assert_not_called()

    def test_only_native_build_unit_can_receive_public_source_network(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'BASE', Path(temp)), \
                patch.object(TRIAL, 'run') as process:
            for unit in (TRIAL.CORE_UNIT, TRIAL.TASK_UNIT, 'untrusted.service'):
                with self.assertRaisesRegex(ValueError, 'native_build_network_scope'):
                    TRIAL.start(unit, ['inert'], 11 * TRIAL.GIB, 1800, public_source_build=True)
            process.assert_not_called()
            TRIAL.start(TRIAL.NATIVE_UNIT, ['inert'], 11 * TRIAL.GIB, 1800, public_source_build=True)
            args = process.call_args.args[0]
            for field in ('--property=PrivateNetwork=no', '--property=MemoryMax=' + str(11 * TRIAL.GIB),
                          '--property=MemorySwapMax=0', '--property=RuntimeMaxSec=1800',
                          '--property=KillMode=control-group', '--property=NoNewPrivileges=yes'):
                self.assertIn(field, args)
            TRIAL.start(TRIAL.CORE_UNIT, ['inert'], 11 * TRIAL.GIB, 2700)
            self.assertIn('--property=PrivateNetwork=yes', process.call_args.args[0])
        with patch.object(TRIAL.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            TRIAL.unit(TRIAL.NATIVE_UNIT, 'stop')
            self.assertEqual(TRIAL.cgroup(TRIAL.NATIVE_UNIT).name, TRIAL.NATIVE_UNIT)

    def test_native_helper_refuses_host_before_acquisition_or_build(self):
        with patch.object(NATIVE.os, 'getuid', return_value=0), patch.object(NATIVE.subprocess, 'run') as process:
            with self.assertRaisesRegex(ValueError, 'disposable_guest_required'):
                NATIVE.guest_build()
            process.assert_not_called()

    def test_actual_build_shell_prefix_forwards_backend_before_any_profile_or_sudo(self):
        script = (ROOT / 'scripts/opencode_ci_build.sh').read_text()
        prefix, separator, _ = script.partition('profile="$core/tests/integration/native-coding-bwrap.apparmor"')
        self.assertTrue(separator)
        addition = ' --inference-backend "${INFERENCE_BACKEND:-torch}"'
        self.assertEqual(prefix.count(addition), 1)
        # Execute the real shell prefix and the real CLI selector. Only its
        # hosted-machine guard is replaced; no build, profile, sudo or VM runs.
        bridge = '''python3() {
  command /usr/bin/python3 -B -c '
import importlib.util, sys
from pathlib import Path
assert sys.argv[1] == "-B"
path = Path(sys.argv[2]).resolve()
spec = importlib.util.spec_from_file_location("inert_ci_prefix", path)
value = importlib.util.module_from_spec(spec)
spec.loader.exec_module(value)
value.guard = lambda: None
sys.argv = [str(path), *sys.argv[3:]]
value.main()
' "$@"
}
git() {
  test "$#" = 4 && test "$1" = -C && test "$3" = rev-parse && test "$4" = HEAD || return 99
  printf '%s\\n' "$TEST_EXPECTED_CORE"
}
sudo() { return 99; }
'''
        def check(source, model=None, backend=None, core=TRIAL.CORE):
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TEST_EXPECTED_CORE': core}
            if model is not None:
                env['MODEL_PROFILE'] = model
            if backend is not None:
                env['INFERENCE_BACKEND'] = backend
            return subprocess.run(['/bin/bash', '-c', bridge + source + '\nprintf "PREFIX_ACCEPTED\\n"\n'],
                                  cwd=ROOT, env=env, capture_output=True, text=True, timeout=10)
        for model, backend, core in ((None, None, TRIAL.CORE),
                                     (TRIAL.LARGE_MODEL, 'torch', TRIAL.LARGE_CORE),
                                     (TRIAL.LARGE_MODEL, KIND, TRIAL.NATIVE_CORE)):
            result = check(prefix, model, backend, core)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'PREFIX_ACCEPTED\n')
        # The original prefix genuinely fails the native checkout, then the
        # corrected same prefix passes above; failures never reach profile work.
        for source, model, backend, core in (
                (prefix.replace(addition, ''), TRIAL.LARGE_MODEL, KIND, TRIAL.NATIVE_CORE),
                (prefix, TRIAL.LARGE_MODEL, KIND, TRIAL.LARGE_CORE),
                (prefix, TRIAL.MODEL, KIND, TRIAL.NATIVE_CORE),
                (prefix, TRIAL.LARGE_MODEL, 'unknown', TRIAL.NATIVE_CORE)):
            result = check(source, model, backend, core)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('PREFIX_ACCEPTED', result.stdout)

    def test_stacked_source_workflow_keeps_original_jobs_and_only_removes_pr_filter(self):
        source = (ROOT / '.github/workflows/source-checks.yml').read_text()
        self.assertIn('  push:\n    branches: [main]\n  pull_request:\n', source)
        self.assertEqual(source.count('branches: [main]'), 1)
        self.assertNotIn('feature/', source)
        self.assertIn('permissions:\n  contents: read\n', source)
        self.assertIn('timeout-minutes: 5', source)
        self.assertIn("python3 -B -m unittest discover -s tests -p 'test_*opencode*.py'", source)

    def test_acquisition_and_build_use_exact_source_in_guest_not_prebuilt_payload(self):
        source = inspect.getsource(NATIVE.guest_build)
        for text in ("'fetch', '--depth=1', '--no-tags', 'origin', SOURCE", 'builder.verify_source(source)',
                     "'--source', str(source), '--output', str(output), '--execute'",
                     "'GIT_CONFIG_GLOBAL': '/dev/null'", 'https://github.com/ggml-org/llama.cpp.git'):
            self.assertIn(text, source if text.startswith(('builder', "'fetch'", "'--source'"))
                          else (ROOT / 'scripts/opencode_native_cpu.py').read_text())
        self.assertNotIn('ctypes.CDLL', source)
        self.assertNotIn('curl', source)

    def test_guest_keeps_original_task_and_inference_budgets_and_joins_native_unit(self):
        source = inspect.getsource(TRIAL.guest)
        for text in ("model.load_pins(profile['model_profile'], native_cpu_converter=True)",
                     'model.retained_pin_files(pins)', "'--native-cpu-source'", "'--native-cpu-build'",
                     "'--native-backend-root'", "'--native-backend-sha256'",
                     "report['native_backend']['manifest_sha256']", 'provision.wait(timeout=1850)',
                     "'--threads', '2', '--max-seconds', '600'", '768 * 1024**2, 2550',
                     'time.monotonic() + 2565', 'created.append(NATIVE_UNIT)', 'for name in reversed(created)',
                     "report['units_empty'] = all(empty(name) for name in created)",
                     "if report['units_empty'] and report['provision_group_joined']:"):
            self.assertIn(text, source)
        task_driver = (ROOT / 'scripts/smoke_opencode_inference.cjs').read_bytes()
        # Exact unchanged source at dd7a709, usable also in a shallow checkout;
        # not regenerated tests, injected answers or a claim of model quality.
        self.assertEqual(hashlib.sha256(task_driver).hexdigest(),
                         '702f0122475ca2e7da6b3f98b446071dcd3baf06af097168cffaa43631f1e484')

    def test_native_memory_requires_actual_zero_swap_and_oom_not_just_limits(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(TRIAL, 'cgroup', return_value=Path(temp)):
            root, limit = Path(temp), 11 * TRIAL.GIB
            original = {'memory.max': str(limit), 'memory.swap.max': '0', 'memory.peak': '123456',
                        'memory.swap.current': '0', 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'}
            def write(values):
                for name, text in values.items():
                    (root / name).write_text(text)
            write(original)
            observed = TRIAL.native_memory(limit)
            self.assertEqual(observed['swap_current'], 0)
            self.assertEqual(observed['oom'], 0)
            for mutation in ({'memory.swap.current': '1'}, {'memory.swap.max': '1'},
                             {'memory.max': str(limit + 1)}, {'memory.peak': str(limit + 1)},
                             {'memory.events': 'oom 1\noom_kill 0\n'},
                             {'memory.events': 'oom 0\noom_kill 1\n'}):
                write(dict(original, **mutation))
                with self.assertRaisesRegex(ValueError, 'native_build_resource_violation'):
                    TRIAL.native_memory(limit)
            write(original)
            (root / 'memory.swap.current').unlink()
            with self.assertRaises(OSError):
                TRIAL.native_memory(limit)

    def test_native_conversion_diagnostic_is_exact_opt_in_and_no_raw_export(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'provision.log'
            path.write_bytes(b'NATIVE_CONVERSION_FAILED\nProvisioning refused: Command CANARY returned non-zero exit status 1.\n')
            path.chmod(0o600)
            legacy = TRIAL.closed_provision(path, None, 'process', 1)
            native = TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
            self.assertEqual(set(legacy), set(native))
            self.assertEqual(legacy['failure_class'], 'runtime_subprocess')
            self.assertEqual(native['failure_class'], 'native_conversion')
            self.assertNotIn('CANARY', json.dumps(native))
            for raw in (b'NATIVE_CONVERSION_FAILED CANARY\n', b'prefix NATIVE_CONVERSION_FAILED\n',
                        b'NATIVE_CONVERSION_FAILED\n' + b'x' * 131073):
                path.write_bytes(raw)
                self.assertNotEqual(TRIAL.closed_provision(path, None, 'process', 1, native_cpu=True)
                                    ['failure_class'], 'native_conversion')

    def test_native_unit_diagnostics_are_closed_and_do_not_invent_log_inspection(self):
        value = TRIAL.closed_native_unit({'ActiveState': 'failed', 'Result': 'timeout',
                                         'ExecMainStatus': '9', 'private': 'CANARY'})
        self.assertEqual(value, {'active': 'failed', 'result': 'timeout', 'status': 9})
        self.assertNotIn('CANARY', json.dumps(value))
        self.assertNotIn('stderr', json.dumps(value))

    def bundle_fixture(self, directory):
        base, core = Path(directory) / 'base', Path(directory) / 'core'
        build_root, backend = base / 'llama-build', base / 'ml/native-backend'
        wrappers = core / 'workers/volparossa-ml/native-cpu'
        for path in (build_root, backend, wrappers):
            path.mkdir(mode=0o700, parents=True)
        def artifact(path, content):
            path.write_bytes(content)
            return {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
        library = artifact(build_root / 'libvolparossa_llama_cpu.so', b'inert library bytes, never loaded')
        (backend / 'libvolparossa_llama_cpu.so').write_bytes((build_root / 'libvolparossa_llama_cpu.so').read_bytes())
        wrapper = {name: artifact(wrappers / name, b'inert source ' + name.encode())
                   for name in ('CMakeLists.txt', 'adapter.h', 'adapter.cpp')}
        raw_build = dict(version=1, kind=KIND, source_commit=NATIVE.SOURCE, source_tree='b' * 40,
                         abi_version=1, jobs=2, cpu='avx2_fma_f16c', models_loaded=False, downloads=False,
                         install=False, sanitizers=False, provisionable=True, quantization=False,
                         library={'path': 'libvolparossa_llama_cpu.so', **library}, wrapper_sources=wrapper,
                         dynamic_dependencies=['libc.so.6'])
        for root in (build_root, backend):
            (root / 'build.json').write_text(json.dumps(raw_build))
        build_hash = hashlib.sha256((build_root / 'build.json').read_bytes()).hexdigest()
        gguf = artifact(backend / 'model.gguf', b'inert gguf bytes, never loaded')
        manifest = dict(model_profile=NATIVE.MODEL, build_manifest_sha256=build_hash,
                        library=raw_build['library'], gguf={'path': 'model.gguf', **gguf}, source_weights_sha256='c' * 64)
        (backend / 'backend.json').write_text(json.dumps(manifest))
        report = dict(native_cpu_converter={'implementation': KIND, 'dependencies': {'sentencepiece': '0.2.1'}},
                      native_backend={'kind': KIND, 'root': str(backend),
                                      'backend_sha256': hashlib.sha256((backend / 'backend.json').read_bytes()).hexdigest()})
        # Core parsers/builders have separate tests; these doubles exercise only
        # this fixture consumer's artifact/provenance checks, not model evidence.
        builder = SimpleNamespace(SOURCE=NATIVE.SOURCE, ORIGIN=NATIVE.ORIGIN, KIND=KIND,
                                  ALLOWED_NEEDED={'libc.so.6'}, verify_source=lambda _path: 'b' * 40)
        parser = SimpleNamespace(validate_manifest=lambda _value, _require: None)
        return base, core, report, builder, parser

    def test_exact_build_and_converted_manifest_bind_actual_inert_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            base, core, report, builder, parser = self.bundle_fixture(temp)
            with patch.object(NATIVE, 'module', return_value=builder):
                build = NATIVE.validate_build(core, base)
            with patch.object(NATIVE, 'module', return_value=parser):
                result = NATIVE.validate_provision(core, base, report, build)
                self.assertEqual(result['manifest_sha256'], report['native_backend']['backend_sha256'])
                self.assertNotIn(str(base), json.dumps(result))
                for mutation in ({'native_cpu_converter': {}},
                                 {'native_backend': dict(report['native_backend'], root='/untrusted')},
                                 {'native_backend': dict(report['native_backend'], backend_sha256='0' * 64)}):
                    with self.assertRaises(ValueError):
                        NATIVE.validate_provision(core, base, dict(report, **mutation), build)
                (base / 'ml/native-backend/model.gguf').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'native_artifact_binding'):
                    NATIVE.validate_provision(core, base, report, build)
            (core / 'workers/volparossa-ml/native-cpu/adapter.cpp').write_bytes(b'changed')
            with patch.object(NATIVE, 'module', return_value=builder), self.assertRaisesRegex(ValueError, 'native_wrapper_binding'):
                NATIVE.validate_build(core, base)


if __name__ == '__main__':
    unittest.main()
