# SPDX-License-Identifier: GPL-3.0-only
"""Disposable path validation only; no privileged namespace or real peer task."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('cooperative_opencode_session', ROOT / 'scripts/opencode_session.py')
SESSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SESSION)


class CooperativeNamespaceTests(unittest.TestCase):
    def test_only_optional_enrolled_proxy_and_trusted_sources_are_mounted(self):
        args = (Path('/fixture/opencode'), Path('/fixture/node'), Path('/fixture/private.sock'),
                Path('/fixture/project'), Path('/home/fixture'))
        local = SESSION.command(*args)
        self.assertNotIn('/opt/core/cooperative.sock', local)
        self.assertNotIn('/opt/src/opencode-cooperative-tool.js', local)
        shared = SESSION.command(*args, Path('/fixture/proxy.sock'))
        triples = [shared[i:i + 3] for i in range(len(shared) - 2)]
        self.assertIn(['--ro-bind', '/fixture/proxy.sock', '/opt/core/cooperative.sock'], triples)
        self.assertIn(['--ro-bind', str(ROOT / 'src/cooperative-tool-client.cjs'),
                       '/opt/src/cooperative-tool-client.cjs'], triples)
        self.assertIn(['--ro-bind', str(ROOT / 'src/opencode-cooperative-tool.js'),
                       '/opt/src/opencode-cooperative-tool.js'], triples)
        self.assertEqual([value for value in triples if value[0] == '--bind'],
                         [['--bind', '/fixture/project', '/workspace']])
        self.assertIn('--unshare-net', shared)
        self.assertIn('--clearenv', shared)
        self.assertNotIn('/opt/core/public.sock', shared)

    @unittest.skipIf(os.getuid() == 0, 'production owner must be unprivileged')
    def test_optional_proxy_obeys_exact_private_owner_socket_validation(self):
        with tempfile.TemporaryDirectory(prefix='vpc-coop-runtime-') as runtime_dir, \
                tempfile.TemporaryDirectory(prefix='vpc-coop-project-') as project_dir:
            runtime = Path(runtime_dir)
            binary, node = runtime / 'opencode', runtime / 'node'
            for item in (binary, node):
                item.write_bytes(b'synthetic validation-only artifact')
                item.chmod(0o700)
            pin = json.loads((ROOT / 'third_party/opencode.json').read_text())
            report = runtime / 'build-report.json'
            report.write_text(json.dumps({'version': 1, 'source_commit': SESSION.PIN,
                'source_build': True, 'lock_sha256': pin['bun_lock_sha256'],
                'patch_sha256': SESSION.digest(ROOT / pin['local_patch']),
                'binary_sha256': SESSION.digest(binary), 'runtime_version': pin['tag'][1:]}))
            report.chmod(0o600)
            private, cooperative = runtime / 'private', runtime / 'cooperative'
            private.mkdir(mode=0o700)
            cooperative.mkdir(mode=0o700)
            ipc, proxy = private / 'compute.sock', cooperative / 'proxy.sock'
            with socket.socket(socket.AF_UNIX) as first, socket.socket(socket.AF_UNIX) as second:
                first.bind(str(ipc))
                second.bind(str(proxy))
                ipc.chmod(0o600)
                proxy.chmod(0o600)
                config = {'version': 1, 'opencode': str(binary), 'opencodeSha256': SESSION.digest(binary),
                          'buildReport': str(report), 'node': str(node), 'nodeSha256': SESSION.digest(node),
                          'socketPath': str(ipc)}
                self.assertIsNone(SESSION.validate(config, project_dir)[-1])
                enabled = config | {'cooperativeSocketPath': str(proxy)}
                self.assertEqual(SESSION.validate(enabled, project_dir)[-1], proxy)
                for invalid in (config | {'cooperativeSocketPath': str(ipc)},
                                enabled | {'cooperativeSocketPath': 'relative'},
                                enabled | {'publicCoreSocket': str(proxy)}):
                    with self.assertRaises(ValueError):
                        SESSION.validate(invalid, project_dir)
                cooperative.chmod(0o755)
                with self.assertRaises(ValueError):
                    SESSION.validate(enabled, project_dir)
                cooperative.chmod(0o700)
                proxy.chmod(0o666)
                with self.assertRaises(ValueError):
                    SESSION.validate(enabled, project_dir)


if __name__ == '__main__':
    unittest.main()
