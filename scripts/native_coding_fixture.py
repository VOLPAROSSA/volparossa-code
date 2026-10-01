#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Three real bounded actions on a disposable synthetic file; no model or canned repair."""
import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import unittest

PROJECT = Path('/opt/work/project')
SOURCE = PROJECT / 'arithmetic.py'
ORIGINAL = 'def add(a, b):\n    return a - b\n'


def source_text():
    info = SOURCE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 256:
        raise ValueError('fixture_source')
    return SOURCE.read_text(encoding='ascii')


def expression(value):
    if not 1 <= len(value) <= 80:
        raise ValueError('expression_bound')
    tree = ast.parse(value, mode='eval')
    nodes = list(ast.walk(tree))
    if len(nodes) > 24 or any(type(node) not in (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Name,
            ast.Load, ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.UAdd, ast.USub) for node in nodes):
        raise ValueError('expression_scope')
    for node in nodes:
        if isinstance(node, ast.Name) and node.id not in ('a', 'b'):
            raise ValueError('expression_name')
        if isinstance(node, ast.Constant) and (type(node.value) is not int or not -100 <= node.value <= 100):
            raise ValueError('expression_number')
    return value


def checked_source(value):
    prefix = 'def add(a, b):\n    return '
    if not value.startswith(prefix) or not value.endswith('\n') or '\n' in value[len(prefix):-1]:
        raise ValueError('source_shape')
    expression(value[len(prefix):-1])
    return value


def main():
    if Path.cwd() != PROJECT or os.getuid() == 0:
        raise ValueError('fixture_scope')
    current = checked_source(source_text())
    action = sys.argv[1] if len(sys.argv) >= 2 else ''
    if action == 'read' and len(sys.argv) == 2:
        print(json.dumps(dict(action='read', source=current)))
    elif action == 'edit' and len(sys.argv) == 3:
        replacement = 'def add(a, b):\n    return ' + expression(sys.argv[2]) + '\n'
        # Validated exact fixture inode; no arbitrary filename or executable input.
        fd = os.open(SOURCE, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
        with os.fdopen(fd, 'w', encoding='ascii') as output:
            output.write(replacement)
        print(json.dumps(dict(action='edit', sha256=hashlib.sha256(replacement.encode()).hexdigest())))
    elif action == 'test' and len(sys.argv) == 2:
        namespace = {}
        exec(compile(current, str(SOURCE), 'exec'), {'__builtins__': {}}, namespace)
        add = namespace['add']
        class ArithmeticTests(unittest.TestCase):
            def test_positive(self):
                self.assertEqual(add(2, 3), 5)
            def test_zero(self):
                self.assertEqual(add(9, 0), 9)
            def test_negative(self):
                self.assertEqual(add(-4, 2), -2)
        result = unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(ArithmeticTests))
        print(json.dumps(dict(action='test', passed=result.wasSuccessful(), tests=result.testsRun)))
        return 0 if result.wasSuccessful() else 1
    else:
        raise ValueError('fixture_action')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, SyntaxError, IndexError, ZeroDivisionError):
        print('synthetic_fixture_action_failed', file=sys.stderr)
        raise SystemExit(1) from None
