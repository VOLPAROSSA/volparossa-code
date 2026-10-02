#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Real bounded arithmetic fixture for the disposable native-editor UI trial."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

import native_coding_fixture as fixture

NAMES = ('arithmetic.py', 'editor_fixture.py', 'native_coding_fixture.py')
JOURNAL = '.editor-ui-actions.jsonl'


def project(value):
    path = Path(value)
    info = path.lstat()
    if (os.getuid() == 0 or not path.is_absolute() or path.resolve(strict=True) != path
            or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
            or not re.fullmatch(r'editor-ui-project-[a-zA-Z0-9_-]{1,32}', path.name)):
        raise ValueError('fixture_project_scope')
    return path


def prepare(path):
    if list(path.iterdir()):
        raise ValueError('fixture_project_not_empty')
    source = Path(__file__).resolve().parent
    for name, content, mode in (
            ('arithmetic.py', fixture.ORIGINAL.encode(), 0o600),
            ('editor_fixture.py', Path(__file__).read_bytes(), 0o444),
            ('native_coding_fixture.py', (source / 'native_coding_fixture.py').read_bytes(), 0o444)):
        fd = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
    return 0


def journal(action, passed):
    path = Path('/workspace') / JOURNAL
    if path.exists():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 2048):
            raise ValueError('fixture_journal_scope')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(json.dumps({'action': action, 'passed': passed}, separators=(',', ':')) + '\n')


def main():
    if len(sys.argv) == 3 and sys.argv[1] in ('--prepare-project', '--verify-project'):
        selected = project(sys.argv[2])
        if sys.argv[1] == '--prepare-project':
            return prepare(selected)
        fixture.PROJECT = selected
        fixture.SOURCE = selected / 'arithmetic.py'
        os.chdir(selected)
        sys.argv = [sys.argv[0], 'test']
        return fixture.main()  # Independent verification does not enter the native-action journal.
    if Path.cwd() != Path('/workspace') or len(sys.argv) not in (2, 3):
        raise ValueError('fixture_execution_scope')
    action = sys.argv[1]
    if action not in ('read', 'edit', 'test'):
        raise ValueError('fixture_action')
    fixture.PROJECT = Path('/workspace')
    fixture.SOURCE = fixture.PROJECT / 'arithmetic.py'
    status = fixture.main()
    journal(action, status == 0)
    return status


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, SyntaxError, IndexError, ZeroDivisionError):
        print('editor_ui_fixture_failed', file=sys.stderr)
        sys.exit(1)
