#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Thin hosted-CI binding to the core-owned real public code topology.

No VM, model scheduler or acceptance criteria are implemented here. The separate
workflow revision and immutable driver source are both recorded explicitly.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
CORE = 'f25352dfbbbf98d1a1fcbbd43f6a91897d73f303'
DRIVER = 'f27576ebd7e7ded2f1319186f34df87f48e970d7'
DRIVER_TREE = '14268639d341eeaaba2e9371d2d9c6537fce57ff'
SCENARIO = 'agent-cooperative-code-proposal'
MODEL = 'qwen3-0.6b-v1'
RECEIPTS = ('public-code-source.json', 'public-code-inputs.json', 'public-code-runner.json')


def require(value, reason):
    if not value:
        raise ValueError(reason)


def module(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def ci():
    return module(ROOT / 'scripts/opencode_ci.py', 'public_ci_shared')


def core_pin():
    require(isinstance(CORE, str) and re.fullmatch('[0-9a-f]{40}', CORE), 'core_fixture_not_pinned')
    return CORE


def core_path():
    value = BUILD / 'public-code-core'
    require(value.resolve(strict=True) == value, 'core_scope')
    return value


def output_path():
    temporary = Path(os.environ.get('RUNNER_TEMP', ''))
    require(temporary.is_absolute() and temporary.resolve(strict=True) == temporary, 'runner_output_scope')
    return temporary / 'alpha-topology-agent-cooperative-code-proposal'


def record(name, value):
    require(name in RECEIPTS, 'receipt_scope')
    ci().record(BUILD / name, value)


def fixture():
    return runpy.run_path(str(core_path() / 'tests/integration/agent-cooperative-code-proposal.py'))


def sources(expected):
    shared = ci()
    shared.guard()
    require(re.fullmatch('[0-9a-f]{40}', expected or '') and expected == os.environ.get('GITHUB_SHA'), 'exact_workflow_source')
    core = core_path()
    for repository, revision in ((ROOT, expected), (core, core_pin())):
        require(shared.run(['git', '-C', repository, 'rev-parse', 'HEAD'], text=True).stdout.strip() == revision
            and not shared.run(['git', '-C', repository, 'status', '--porcelain'], text=True).stdout,
            'clean_exact_sources')
    shared.run(['git', '-C', ROOT, 'merge-base', '--is-ancestor', DRIVER, expected])
    require(shared.run(['git', '-C', ROOT, 'rev-parse', DRIVER + '^{tree}'], text=True).stdout.strip() == DRIVER_TREE,
            'driver_source_tree')
    checked = fixture()
    require(checked['CODE_REVISION'] == DRIVER and checked['PROFILE'] == MODEL, 'core_driver_binding')
    value = dict(version=1, workflow_code_revision=expected,
        workflow_code_tree=shared.run(['git', '-C', ROOT, 'rev-parse', 'HEAD^{tree}'], text=True).stdout.strip(),
        driver_code_revision=DRIVER, driver_code_tree=DRIVER_TREE, core_revision=CORE,
        core_tree=shared.run(['git', '-C', core, 'rev-parse', 'HEAD^{tree}'], text=True).stdout.strip(),
        exact_clean_sources=True, scenario=SCENARIO, model_profile=MODEL,
        native_editor_ui_proven=False, private_opencode_planner_proven=False, actual_execution_proven=False)
    record('public-code-source.json', value)
    return value


def assets():
    shared = ci()
    shared.guard()
    require(shared.run(['git', '-C', core_path(), 'rev-parse', 'HEAD'], text=True).stdout.strip() == core_pin(), 'exact_core')
    private = module(core_path() / 'tests/integration/agent-private-conversation.py', 'public_ci_node')
    pin = private.pins()['runtime']
    private.fetch(pin['url'], BUILD / 'public-code-node.tar.xz', pin)
    with tarfile.open(BUILD / 'public-code-node.tar.xz', 'r:xz') as archive:
        private.extract_node(archive, BUILD / 'public-code-node', pin['files'])


def pack():
    shared = ci()
    shared.guard()
    source = json.loads((BUILD / 'public-code-source.json').read_bytes())
    require(source['workflow_code_revision'] == os.environ.get('GITHUB_SHA') and source['core_revision'] == core_pin()
        and source['driver_code_revision'] == DRIVER and source['driver_code_tree'] == DRIVER_TREE, 'input_source')
    capture = module(ROOT / 'scripts/pack_opencode_cooperation.py', 'public_ci_pack')
    bundle = BUILD / 'public-code-proposal-inputs-ci'
    value = capture.pack_proposal(argparse.Namespace(code_revision=DRIVER,
        node=BUILD / 'public-code-node/bin/node', output=bundle))
    manifest = json.loads((bundle / 'INPUTS.json').read_bytes())
    fixture()['bundle_manifest'](manifest)
    record('public-code-inputs.json', dict(version=1, core_revision=CORE, driver_code_revision=DRIVER,
        manifest_sha256=value['manifest_sha256'], manifest=manifest, model_profile=MODEL,
        local_planner_used=False, actual_execution_proven=False))
    return value


def runner_status(status):
    ci().guard()
    require(type(status) is int and 0 <= status <= 255, 'runner_status')
    record('public-code-runner.json', dict(version=1, core_revision=core_pin(), scenario=SCENARIO,
        exit_status=status, native_editor_ui_proven=False, private_opencode_planner_proven=False))


def gate():
    ci().guard()
    original = json.loads((BUILD / 'public-code-runner.json').read_bytes())
    require(original == dict(version=1, core_revision=core_pin(), scenario=SCENARIO, exit_status=0,
        native_editor_ui_proven=False, private_opencode_planner_proven=False), 'runner_did_not_pass')
    report = output_path() / (SCENARIO + '-smoke.json')
    # Reuse the core's original source/worker/EOS/owner-test/route/privacy and
    # cleanup assertions, rather than constructing a weaker app-side success.
    fixture()['check_report'](json.loads(report.read_bytes()), CORE)


def copy_receipt(source, target):
    info = source.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
        and not info.st_mode & 0o077 and 0 < info.st_size <= 1048576, 'closed_receipt_file')
    raw = source.read_bytes()
    require(type(json.loads(raw)) is dict, 'closed_receipt_object')
    with target.open('xb') as output:
        output.write(raw)
    target.chmod(0o600)


def export():
    ci().guard()
    destination = BUILD / 'public-code-receipts'
    destination.mkdir(mode=0o700)
    # These are pinned, closed core producers, not arbitrary files in VM output.
    names = fixture()['EXPORT_NAMES'] + ('host-state-before.json', 'host-state-after.json')
    require(all(re.fullmatch('[a-z0-9-]+[.]json', name) for name in names), 'export_names')
    for root, selected in ((BUILD, RECEIPTS), (output_path(), names)):
        for name in selected:
            candidate = root / name
            if candidate.exists() or candidate.is_symlink():
                copy_receipt(candidate, destination / name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('guard', 'select', 'source', 'assets', 'pack', 'runner-status', 'gate', 'export'))
    parser.add_argument('--expected-code')
    parser.add_argument('--exit-status', type=int)
    args = parser.parse_args(argv)
    if args.mode == 'guard':
        ci().guard()
    elif args.mode == 'select':
        ci().guard()
        print('core_revision=' + core_pin())
    elif args.mode == 'source':
        sources(args.expected_code)
    elif args.mode == 'runner-status':
        runner_status(args.exit_status)
    else:
        {'assets': assets, 'pack': pack, 'gate': gate, 'export': export}[args.mode]()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, tarfile.TarError):
        print(json.dumps(dict(passed=False, stage='public_code_ci', failure='closed_stage_failed')))
        raise SystemExit(1)
