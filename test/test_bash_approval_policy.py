import unittest

from agent.infrastructure.tools.impl.tools.bash_policy import BashPolicy

class TestBashApprovalPolicy(unittest.TestCase):
    def test_forbidden_commands(self):
        status, reason = BashPolicy.classify("format C:")
        self.assertEqual(status, "deny")
        self.assertIn("format", reason.lower())

        status, reason = BashPolicy.classify("sudo reboot")
        self.assertEqual(status, "deny")

    def test_confirmable_commands(self):
        # We assume unsafe mode is disabled by default for testing
        import os
        os.environ["AGENT_ALLOW_UNSAFE_BASH"] = "0"

        status, reason = BashPolicy.classify("rm -rf /tmp/test")
        self.assertEqual(status, "needs_approval")
        self.assertIn("rm", reason.lower())

    def test_safe_commands(self):
        status, reason = BashPolicy.classify("ls -la")
        self.assertEqual(status, "allow")
        self.assertIsNone(reason)

if __name__ == "__main__":
    unittest.main()
