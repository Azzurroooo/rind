import os
import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import agent.prompts as prompts
import agent.infrastructure.environment as environment
from agent.infrastructure.environment import ShellDetection


def test_system_info_omits_start_time(monkeypatch):
    monkeypatch.setattr(environment, "detect_default_shell", lambda: ShellDetection("/bin/bash", "bash"))

    info = environment.get_system_info()

    assert "Start Time:" not in info
    assert "Start Time:" not in prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))


def test_system_info_includes_current_date_without_time(monkeypatch):
    monkeypatch.setattr(environment, "detect_default_shell", lambda: ShellDetection("/bin/bash", "bash"))

    today = date.today().isoformat()
    info = environment.get_system_info()

    assert f"Current Date: {today}" in info
    assert f"Current Date: {today}" in prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))
    assert "Current Time:" not in info
    assert "Current Time:" not in prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))


def test_system_info_uses_detected_shell_backend(monkeypatch):
    shell_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    monkeypatch.setattr(environment, "detect_default_shell", lambda: ShellDetection(shell_path, "powershell"))

    info = environment.get_system_info()

    assert "Shell Type: PowerShell" in info
    assert f"Shell Executable: {shell_path}" in info


def test_system_prompt_contains_rind_doc_rules():
    text = prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))

    assert "`write_file`" in text
    assert "`edit_file`" in text
    assert "`apply_patch`" not in text
    assert "RIND.md Context Docs" in text
    assert "32 KiB byte budget" in text
    assert "Never create, update, delete, or rename any `RIND.md`" in text
    assert "not automatically updated memory" in text


def test_system_prompt_describes_file_mutation_contracts():
    text = prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))

    assert "Atomically create or completely overwrite a UTF-8 text file" in text
    assert "Atomically replace one unique, exact text block" in text
    assert "Each edit sees earlier changes" in text
    assert "No hash parameter is required" in text and "SHA-256" not in text


def test_system_prompt_strongly_limits_emojis():
    text = prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))

    assert 'Use emojis ONLY if the user explicitly requests them' in text
    assert 'AVOID using emojis in all communication unless asked' in text

def test_system_prompt_describes_path_roots():
    text = prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))

    assert "`cwd` for a command-specific directory" in text
    assert "File tools still resolve paths from the project directory" in text
    assert "Project-level `RIND.md` and project skills are rooted at the Current Working Directory" in text


def test_system_prompt_requires_parallel_independent_tool_calls():
    text = prompts.build_system_prompt(str(PROJECT_ROOT), environment=environment.get_system_info(PROJECT_ROOT))

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
    assert "Use `write_file` when the target does not exist" in prompt
    assert "use `edit_file` to preserve unrelated content" in prompt


def test_rind_init_prompt_scopes_user_file():
    prompt = prompts.build_rind_init_prompt("user", r"C:\Users\me\.rind\RIND.md")

    assert "user-level Rind context document" in prompt
    assert "Do not copy project facts into the user-level file." in prompt
    assert "Do not invent preferences." in prompt
    assert r"C:\Users\me\.rind\RIND.md" in prompt
    assert "Use `write_file` when the target does not exist" in prompt
    assert "use `edit_file` to preserve unrelated content" in prompt


def test_compact_prompt_has_stable_handoff_instructions():
    messages = prompts.build_compact_prompt('[{"role":"user","content":"finish task"}]')

    assert [message["role"] for message in messages] == ["system", "user"]
    assert "Do not invent facts." in messages[0]["content"]
    assert "Required sections:" in messages[1]["content"]
    assert "- Current goal" in messages[1]["content"]
    assert "- Risks and next checks" in messages[1]["content"]
    assert 'Compression corpus JSON:\n[{"role":"user","content":"finish task"}]' in messages[1]["content"]
