"""Classification only: forbidden commands are never executed in these tests."""

import pytest

from agent.infrastructure.tools.builtin.shell.policy import BashPolicy


@pytest.mark.parametrize("command", [
    "python - <<'EOF'\n# check suffix format\nprint('ok')\nEOF",
    'git show --name-only --format="" HEAD | head -40',
    'git show --name-only --format="%H %s" HEAD | head -50',
    "python - <<'EOF'\nprint(\"code format sample:\", 'ok')\nEOF",
    'git log --name-only --pretty=format: | head -5',
    "python - <<'EOF'\nprint(\"index format sample:\", 'ok')\nEOF",
    'echo "format D:; mkfs /dev/example"',
    "# format D:\necho ok",
    "printf '%s' 'format'",
    'git grep "shutdown"',
    "echo ':(){ :|:& };:'",
    "echo $(printf ok) format",
    "echo `printf ok` format",
])
def test_data_comments_and_git_options_are_allowed(command):
    assert BashPolicy.classify(command)[0] == "allow"


@pytest.mark.parametrize("command", [
    "format D:", "FORMAT.COM D:", '"C:\\Windows\\System32\\format.com" D:',
    "/c/Windows/System32/format.com D:", "/sbin/mkfs.ext4 /dev/example",
    "echo ok | mkfs /dev/example", "echo ok && format D:", "echo ok; reboot", "echo ok\nshutdown /s",
    "(format D:)", "sudo mkfs /dev/example", 'cmd /c "format D:"', "bash -lc 'mkfs.ext4 /dev/example'",
    'echo "$(format D:)"', "echo `reboot`", ":(){ :|:& };:",
    "python - <<'EOF'\nprint('format')\nEOF\nformat D:",
])
def test_forbidden_invocations_stay_blocked(command):
    assert BashPolicy.classify(command)[0] == "deny"


@pytest.mark.parametrize("command,expected", [
    ('Write-Output "format"', "allow"), ("'format.com'", "allow"),
    ("& 'C:\\Windows\\System32\\format.com' D:", "deny"),
    (". 'format.com' D:", "deny"),
    ("Get-Item . | Format-List", "allow"), ("Format-Volume -DriveLetter D", "deny"),
    ('powershell -Command "format.com D:"', "deny"),
])
def test_powershell_invocation_and_data(command, expected):
    assert BashPolicy.classify(command, "powershell")[0] == expected
