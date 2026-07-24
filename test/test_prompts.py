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
    monkeypatch.setattr(prompts, "ShellSessionPool", lambda: FakeShellPool("bash", "/bin/bash"))

    info = prompts.get_system_info()

    assert "Start Time:" not in info
    assert "Start Time:" not in prompts.SYSTEM_PROMPT


def test_system_info_includes_current_date_without_time(monkeypatch):
    monkeypatch.setattr(prompts, "ShellSessionPool", lambda: FakeShellPool("bash", "/bin/bash"))

    today = date.today().isoformat()
    info = prompts.get_system_info()

    assert f"Current Date: {today}" in info
    assert f"Current Date: {today}" in prompts.SYSTEM_PROMPT
    assert "Current Time:" not in info
    assert "Current Time:" not in prompts.SYSTEM_PROMPT


def test_system_info_uses_detected_shell_backend(monkeypatch):
    shell_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    monkeypatch.setattr(prompts, "ShellSessionPool", lambda: FakeShellPool("powershell", shell_path))

    info = prompts.get_system_info()

    assert "Shell Type: PowerShell" in info
    assert f"Shell Executable: {shell_path}" in info


def test_system_prompt_contains_rind_doc_rules():
    text = prompts.SYSTEM_PROMPT

    assert "`apply_patch`" in text
    assert "`write_file`" not in text
    assert "`edit_file`" not in text
    assert "only accepted absolute path is the exact user-level `RIND.md` path" in text
    assert "RIND.md Context Docs" in text
    assert "32 KiB byte budget" in text
    assert "Never create, update, delete, or rename any `RIND.md`" in text
    assert "not automatically updated memory" in text


def test_system_prompt_shows_apply_patch_example_and_failure_checks():
    text = prompts.SYSTEM_PROMPT

    assert "*** Begin Patch" in text
    assert "*** Expected SHA256: <sha256 from read_file>" in text
    assert "start every `Update File` hunk with `@@`" in text
    assert "keep explanations outside the patch" in text


def test_system_prompt_strongly_limits_emojis():
    text = prompts.SYSTEM_PROMPT

    assert 'Use emojis ONLY if the user explicitly requests them' in text
    assert 'AVOID using emojis in all communication unless asked' in text

def test_system_prompt_describes_path_roots():
    text = prompts.SYSTEM_PROMPT

    assert "cd` commands affect subsequent `bash` calls only" in text
    assert "file tools still resolve relative paths from the Current Working Directory" in text
    assert "Project-level `RIND.md` and project skills are rooted at the Current Working Directory" in text


def test_system_prompt_requires_parallel_independent_tool_calls():
    text = prompts.SYSTEM_PROMPT

    assert "independent" in text
    assert "in parallel in the same response" in text
    assert "reduce round trips and improve efficiency" in text
    assert "dependent calls sequentially" in text


def test_rind_init_prompt_scopes_project_file():
    prompt = prompts.build_rind_init_prompt("project", r"C:\repo\RIND.md")

    assert "project-level Rind context document" in prompt
    assert r"C:\repo\RIND.md" in prompt
    assert "Explore the project lightly before writing" in prompt
    assert "Do not modify the other RIND.md level." in prompt
    assert "32 KiB byte budget" in prompt
    assert "Use only `apply_patch`" in prompt
    assert "use `RIND.md` exactly" in prompt


def test_rind_init_prompt_scopes_user_file():
    prompt = prompts.build_rind_init_prompt("user", r"C:\Users\me\.rind\RIND.md")

    assert "user-level Rind context document" in prompt
    assert "Do not copy project facts into the user-level file." in prompt
    assert "Do not invent preferences." in prompt
    assert r"C:\Users\me\.rind\RIND.md" in prompt
    assert "Use only `apply_patch`" in prompt
    assert "use `C:\\Users\\me\\.rind\\RIND.md` exactly" in prompt
