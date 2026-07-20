import os
import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import agent.prompts as prompts


class FakeShellPool:
    def __init__(self, backend: str, executable: str | None):
        self._default_backend = backend
        self._default_executable = executable


def test_system_info_omits_start_time(monkeypatch):
    monkeypatch.setattr(prompts, "BashSessionPool", lambda: FakeShellPool("bash", "/bin/bash"))

    info = prompts.get_system_info()

    assert "Start Time:" not in info
    assert "Start Time:" not in prompts.SYSTEM_PROMPT


def test_system_info_includes_current_date_without_time(monkeypatch):
    monkeypatch.setattr(prompts, "BashSessionPool", lambda: FakeShellPool("bash", "/bin/bash"))

    today = date.today().isoformat()
    info = prompts.get_system_info()

    assert f"Current Date: {today}" in info
    assert f"Current Date: {today}" in prompts.SYSTEM_PROMPT
    assert "Current Time:" not in info
    assert "Current Time:" not in prompts.SYSTEM_PROMPT


def test_system_info_uses_detected_shell_backend(monkeypatch):
    shell_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    monkeypatch.setattr(prompts, "BashSessionPool", lambda: FakeShellPool("powershell", shell_path))

    info = prompts.get_system_info()

    assert "Shell Type: PowerShell" in info
    assert f"Shell Executable: {shell_path}" in info


def test_system_prompt_contains_tangerine_doc_rules():
    text = prompts.SYSTEM_PROMPT

    assert "TANGERINE.md Context Docs" in text
    assert "32 KiB byte budget" in text
    assert "Never create, update, delete, or rename any `TANGERINE.md`" in text
    assert "not automatically updated memory" in text


def test_system_prompt_strongly_limits_emojis():
    text = prompts.SYSTEM_PROMPT

    assert 'Use emojis ONLY if the user explicitly requests them' in text
    assert 'AVOID using emojis in all communication unless asked' in text

def test_system_prompt_describes_path_roots():
    text = prompts.SYSTEM_PROMPT

    assert "cd` commands affect subsequent `bash` calls only" in text
    assert "file tools still resolve relative paths from the Current Working Directory" in text
    assert "Project-level `TANGERINE.md` and project skills are rooted at the Current Working Directory" in text


def test_tangerine_init_prompt_scopes_project_file():
    prompt = prompts.build_tangerine_init_prompt("project", r"C:\repo\TANGERINE.md")

    assert "project-level Tangerine Rind context document" in prompt
    assert r"C:\repo\TANGERINE.md" in prompt
    assert "Explore the project lightly before writing" in prompt
    assert "Do not modify the other TANGERINE.md level." in prompt
    assert "32 KiB byte budget" in prompt


def test_tangerine_init_prompt_scopes_user_file():
    prompt = prompts.build_tangerine_init_prompt("user", r"C:\Users\me\.tangerine\TANGERINE.md")

    assert "user-level Tangerine Rind context document" in prompt
    assert "Do not copy project facts into the user-level file." in prompt
    assert "Do not invent preferences." in prompt
    assert r"C:\Users\me\.tangerine\TANGERINE.md" in prompt
