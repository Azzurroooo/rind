import unittest
import json
import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools.builtin.shell.tool import bash

class TestBashSignatureCompat(unittest.TestCase):
    # This verifies the bash tool signature stays callable with current defaults.
    # Real cancellation behavior is covered by the dedicated bash cancellation tests.

    def test_bash_runs_with_new_signature(self):
        res = asyncio.run(bash("echo 'testing bash'", session_id="test_session"))
        parsed = json.loads(res)
        self.assertTrue(parsed["ok"])
        self.assertIn("testing bash", parsed["data"]["stdout"])

if __name__ == "__main__":
    unittest.main()
