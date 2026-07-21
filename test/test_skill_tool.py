import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain import parse_skill_markdown
from agent.infrastructure.tools.impl import TOOL_SCHEMAS, TOOLS
from agent.infrastructure.tools.impl.tools.skill import skill_create


def _payload(result: str) -> dict:
    return json.loads(result)


def test_skill_create_project_scope(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    result = _payload(
        skill_create(
            name="demo-skill",
            description="Demo skill.",
            body="# Demo\nFollow these instructions.",
            triggers=["demo trigger"],
        )
    )

    skill_file = tmp_path / ".rind" / "skills" / "demo-skill" / "SKILL.md"
    if not result.get("ok"):
        raise AssertionError(f"Expected success, got: {result}")
    if Path(result["data"]["path"]) != skill_file:
        raise AssertionError(f"Unexpected path: {result}")
    if not skill_file.exists():
        raise AssertionError(f"Expected skill file to exist: {skill_file}")

    parsed = parse_skill_markdown(
        text=skill_file.read_text(encoding="utf-8"),
        path=str(skill_file),
        fallback_name="demo-skill",
        source="project",
    )
    if parsed.name != "demo-skill" or parsed.description != "Demo skill.":
        raise AssertionError(f"Unexpected parsed skill: {parsed}")
    if parsed.triggers != ["demo trigger"]:
        raise AssertionError(f"Unexpected parsed triggers: {parsed.triggers}")


def test_skill_create_project_scope_uses_cwd_not_parent_git_root(tmp_path: Path, monkeypatch) -> None:
    project = tmp_path / "project"
    nested = project / "src"
    nested.mkdir(parents=True)
    (project / ".git").mkdir()
    monkeypatch.chdir(nested)

    result = _payload(
        skill_create(
            name="cwd-skill",
            description="Cwd skill.",
            body="# Cwd\nUse current directory.",
        )
    )

    skill_file = nested / ".rind" / "skills" / "cwd-skill" / "SKILL.md"
    parent_skill_file = project / ".rind" / "skills" / "cwd-skill" / "SKILL.md"
    if not result.get("ok"):
        raise AssertionError(f"Expected success, got: {result}")
    if Path(result["data"]["path"]) != skill_file:
        raise AssertionError(f"Unexpected project skill path: {result}")
    if not skill_file.exists():
        raise AssertionError(f"Expected cwd skill file to exist: {skill_file}")
    if parent_skill_file.exists():
        raise AssertionError(f"Did not expect parent git-root skill file: {parent_skill_file}")


def test_skill_create_user_scope(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))

    result = _payload(
        skill_create(
            name="user_skill",
            description="User skill.",
            body="# User\nUse this globally.",
            scope="user",
        )
    )

    skill_file = home / ".rind" / "skills" / "user_skill" / "SKILL.md"
    if not result.get("ok"):
        raise AssertionError(f"Expected success, got: {result}")
    if Path(result["data"]["path"]) != skill_file:
        raise AssertionError(f"Unexpected user skill path: {result}")
    if not skill_file.exists():
        raise AssertionError(f"Expected user skill file to exist: {skill_file}")


def test_skill_create_user_scope_uses_rind_home(tmp_path: Path, monkeypatch) -> None:
    rind_home = tmp_path / "rind-home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("RIND_HOME", str(rind_home))

    result = _payload(
        skill_create(
            name="portable_skill",
            description="Portable skill.",
            body="# Portable\nUse this globally.",
            scope="user",
        )
    )

    skill_file = rind_home / "skills" / "portable_skill" / "SKILL.md"
    if not result.get("ok"):
        raise AssertionError(f"Expected success, got: {result}")
    if Path(result["data"]["path"]) != skill_file:
        raise AssertionError(f"Unexpected RIND_HOME skill path: {result}")
    if not skill_file.exists():
        raise AssertionError(f"Expected user skill file to exist: {skill_file}")


def test_skill_create_rejects_invalid_inputs(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    invalid_names = ["", "../x", "bad/name", "bad name", ".", ".."]
    for name in invalid_names:
        result = _payload(skill_create(name=name, description="Desc", body="Body"))
        if result.get("ok") or result.get("error_type") != "InvalidSkillName":
            raise AssertionError(f"Expected InvalidSkillName for {name!r}, got: {result}")

    empty_description = _payload(skill_create(name="valid", description=" ", body="Body"))
    if empty_description.get("ok") or empty_description.get("error_type") != "ValidationError":
        raise AssertionError(f"Expected empty description rejection, got: {empty_description}")

    empty_body = _payload(skill_create(name="valid", description="Desc", body=" "))
    if empty_body.get("ok") or empty_body.get("error_type") != "ValidationError":
        raise AssertionError(f"Expected empty body rejection, got: {empty_body}")

    invalid_scope = _payload(skill_create(name="valid", description="Desc", body="Body", scope="team"))
    if invalid_scope.get("ok") or invalid_scope.get("error_type") != "InvalidScope":
        raise AssertionError(f"Expected invalid scope rejection, got: {invalid_scope}")


def test_skill_create_overwrite_policy(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)

    first = _payload(skill_create(name="demo", description="First", body="First body"))
    if not first.get("ok"):
        raise AssertionError(f"Expected first create to succeed, got: {first}")

    duplicate = _payload(skill_create(name="demo", description="Second", body="Second body"))
    if duplicate.get("ok") or duplicate.get("error_type") != "SkillAlreadyExists":
        raise AssertionError(f"Expected duplicate rejection, got: {duplicate}")

    overwritten = _payload(skill_create(name="demo", description="Second", body="Second body", overwrite=True))
    if not overwritten.get("ok"):
        raise AssertionError(f"Expected overwrite success, got: {overwritten}")

    skill_file = tmp_path / ".rind" / "skills" / "demo" / "SKILL.md"
    parsed = parse_skill_markdown(skill_file.read_text(encoding="utf-8"), str(skill_file), "demo", "project")
    if parsed.description != "Second":
        raise AssertionError(f"Expected overwritten description, got: {parsed}")


def test_skill_create_schema_registered() -> None:
    if "skill_create" not in TOOLS:
        raise AssertionError("Expected skill_create in TOOLS.")

    schema = next((item for item in TOOL_SCHEMAS if item["function"]["name"] == "skill_create"), None)
    if schema is None:
        raise AssertionError("Expected skill_create schema.")

    scope = schema["function"]["parameters"]["properties"].get("scope")
    if not scope or scope.get("enum") != ["project", "user"]:
        raise AssertionError(f"Expected scope enum in schema, got: {scope}")


def main() -> int:
    import tempfile

    class MiniMonkeyPatch:
        def __init__(self):
            self._cwd = Path.cwd()
            self._env: dict[str, str | None] = {}

        def chdir(self, path):
            os.chdir(path)

        def setenv(self, key, value):
            if key not in self._env:
                self._env[key] = os.environ.get(key)
            os.environ[key] = value

        def undo(self):
            os.chdir(self._cwd)
            for key, value in self._env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    tests = [
        test_skill_create_project_scope,
        test_skill_create_project_scope_uses_cwd_not_parent_git_root,
        test_skill_create_user_scope,
        test_skill_create_user_scope_uses_rind_home,
        test_skill_create_rejects_invalid_inputs,
        test_skill_create_overwrite_policy,
    ]
    for test in tests:
        with tempfile.TemporaryDirectory() as temp_dir:
            monkeypatch = MiniMonkeyPatch()
            try:
                test(Path(temp_dir), monkeypatch)
            finally:
                monkeypatch.undo()
    test_skill_create_schema_registered()
    print("Skill tool tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
