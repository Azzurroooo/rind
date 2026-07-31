import unittest

from agent.infrastructure.tools.builtin.shell.policy import BashPolicy

class TestBashPolicy(unittest.TestCase):
    def test_forbidden_commands(self):
        status, reason = BashPolicy.classify("format C:")
        self.assertEqual(status, "deny")
        self.assertIn("format", reason.lower())

        status, reason = BashPolicy.classify("sudo reboot")
        self.assertEqual(status, "deny")

    def test_destructive_commands_are_allowed(self):
        for command in (
            "rm -rf /tmp/test",
            "del /s /q temp",
            "rmdir /s /q temp",
            "Remove-Item -Recurse output",
        ):
            with self.subTest(command=command):
                status, reason = BashPolicy.classify(command)
                self.assertEqual(status, "allow")
                self.assertIsNone(reason)

    def test_safe_commands(self):
        status, reason = BashPolicy.classify("ls -la")
        self.assertEqual(status, "allow")
        self.assertIsNone(reason)

if __name__ == "__main__":
    unittest.main()
