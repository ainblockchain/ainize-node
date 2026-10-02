import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('ci.sh').resolve()

class GateTests(unittest.TestCase):
    def test_failure_blocks_build_and_a_corrective_commit_has_fresh_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'; source.mkdir()
            (source / 'deploy').mkdir()
            (source / 'deploy/ci-docs.sh').write_text('cd "$1"\nnpm run docs:check\n')
            (source / 'dist').mkdir(); (source / 'dist/bin.js').write_text('test fixture')
            bin_dir = root / 'bin'; bin_dir.mkdir()
            npm = bin_dir / 'npm'
            npm.write_text('#!/bin/sh\necho "$*" >> "$TEST_CALLS"\nif [ "$FAIL_TEST" = 1 ] && [ "$1 $2" = "run test" ]; then echo test-failure; exit 9; fi\nif [ "$FAIL_DOCS" = 1 ] && [ "$1 $2" = "run docs:check" ]; then echo docs-failure; exit 8; fi\n')
            npm.chmod(0o755)
            env = {**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH'], 'AINIZE_CI_STATE_DIR': str(root / 'state'),
                   'TEST_CALLS': str(root / 'calls'), 'FAIL_TEST': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(source), 'a' * 40], env=env)
            self.assertEqual(result.returncode, 9)
            record = json.loads((root / 'state/status.json').read_text())
            self.assertEqual((record['sha'], record['stage'], record['status']), ('a' * 40, 'test', 'failed'))
            self.assertNotIn('run build', (root / 'calls').read_text())
            self.assertIn('test-failure', (root / 'state' / ('a' * 40 + '.log')).read_text())
            env['FAIL_TEST'] = '0'
            result = subprocess.run(['bash', str(SCRIPT), str(source), 'b' * 40], env=env)
            self.assertEqual(result.returncode, 0)
            record = json.loads((root / 'state/status.json').read_text())
            self.assertEqual((record['sha'], record['stage'], record['status']), ('b' * 40, 'complete', 'success'))
            self.assertTrue((root / 'state' / ('a' * 40 + '.log')).exists())
            (root / 'calls').write_text('')
            env['FAIL_DOCS'] = '1'
            result = subprocess.run(['bash', str(SCRIPT), str(source), 'c' * 40], env=env)
            self.assertEqual(result.returncode, 8)
            record = json.loads((root / 'state/status.json').read_text())
            self.assertEqual((record['sha'], record['stage'], record['status']), ('c' * 40, 'docs:check', 'failed'))
            self.assertNotIn('run build', (root / 'calls').read_text())
            self.assertIn('docs-failure', (root / 'state' / ('c' * 40 + '.log')).read_text())

if __name__ == '__main__':
    unittest.main()
