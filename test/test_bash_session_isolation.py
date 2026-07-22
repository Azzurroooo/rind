import unittest
from pathlib import Path

from agent.infrastructure.tools.builtin.shell.session_pool import ShellSessionPool

class TestBashSessionIsolation(unittest.TestCase):
    def test_session_isolation(self):
        pool = ShellSessionPool()

        # State creation
        s1 = pool.get_state("session_1")
        s2 = pool.get_state("session_2")

        self.assertIsNot(s1, s2)

        # Modify s1 cwd
        s1.cwd = "/tmp/s1"

        s1_updated = pool.get_state("session_1")
        s2_updated = pool.get_state("session_2")

        self.assertEqual(s1_updated.cwd, "/tmp/s1")
        self.assertNotEqual(s2_updated.cwd, "/tmp/s1")

        # Reset state
        pool.close("session_1")
        s1_reset = pool.get_state("session_1")
        self.assertNotEqual(s1_reset.cwd, "/tmp/s1")

if __name__ == "__main__":
    unittest.main()
