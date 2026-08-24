import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.commands import SlashCommandContext, SlashCommandInfo, SlashCommandRouter
from agent.runtime.server.commands.git_status import GitPromptStatus
from agent.infrastructure.config import Config
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.skills.repository import SkillRepository
from agent.infrastructure.team import initialize_team_project


@pytest.fixture(autouse=True)
def restore_config_state():
    tracked_names = (
        "SETTINGS",
        "SETTINGS_PATH",
        "SETTINGS_EXISTS",
        "OPENAI_API_KEY",
        "OPENAI_API_BASE",
        "OPENAI_USER_AGENT",
        "DEFAULT_MODEL",
        "MODEL_REASONING_EFFORT",
    )
    attrs = {name: getattr(Config, name) for name in tracked_names if hasattr(Config, name)}
    yield
    for key, value in attrs.items():
        setattr(Config, key, value)


class FakeSession:
    session_id = "session_1"
    model = "model_a"
    async def get_messages_slice(self):
        return [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]

    async def get_latest_sampling_usage(self):
        return None

    async def list_recent_sessions(self, limit=10):
        return []


class FakeRuntime:
    def __init__(self):
        self.called = False
        self.compact_called = False
        self.model = None
        self.query = None
        self.transient_system_messages = None

    def run_turn(self, query=None, cancellation_token=None, transient_system_messages=None):
        self.called = True
        self.query = query
        self.transient_system_messages = transient_system_messages
        return EmptyStream()

    async def compact_context(self, reason="manual", cancellation_token=None):
        self.compact_called = True
        self.cancellation_token = cancellation_token
        return {
            "id": "runtime_compact_1",
            "source": {
                "message_start_index": 0,
                "message_end_index_exclusive": 2,
                "tool_call_ids": [],
            },
        }

    async def set_model(self, model):
        self.model = model
        return {"runtime": True, "session": False}


class EmptyStream:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def aclose(self):
        return None


def _context(session=None, runtime=None):
    return SlashCommandContext(runtime=runtime or FakeRuntime(), session=session or FakeSession(), debug=True)


@pytest.mark.asyncio
async def test_help_returns_command_list() -> None:
    result = await SlashCommandRouter().execute("/help", _context())

    assert "Commands" in result.text
    assert "Operate" in result.text
    assert "/status" in result.text
    assert "Show session status" in result.text
    assert "/doctor" in result.text
    assert "/skill" in result.text
    assert "Use `/help <command>` for usage." in result.text
    assert result.display is not None
    assert result.display["type"] == "help"
    assert any(command["name"] == "status" for command in result.display["commands"])


@pytest.mark.asyncio
async def test_help_returns_command_specific_usage() -> None:
    result = await SlashCommandRouter().execute("/help model", _context())

    assert result.text.startswith("# /model")
    assert "Show or change the active model" in result.text
    assert "Usage" in result.text
    assert "  /model | /model set <model>" in result.text
    assert result.display is not None
    assert result.display["type"] == "help"
    assert result.display["command"]["name"] == "model"


@pytest.mark.asyncio
async def test_help_reports_unknown_command() -> None:
    result = await SlashCommandRouter().execute("/help missing", _context())

    assert "Unknown command: /missing" in result.text
    assert "/help" in result.text


@pytest.mark.asyncio
async def test_help_rejects_too_many_args() -> None:
    result = await SlashCommandRouter().execute("/help model now", _context())

    assert result.text == "Usage: /help [command]"


def test_router_exposes_sorted_command_names() -> None:
    names = SlashCommandRouter().command_names()

    assert names == sorted(names)
    assert "help" in names
    assert "status" in names
    assert "sessions" in names
    assert "team" in names


def test_router_exposes_command_descriptions() -> None:
    infos = SlashCommandRouter().command_infos()
    descriptions = {info.name: info.description for info in infos}
    usages = {info.name: info.usage for info in infos}

    assert [info.name for info in infos] == sorted(descriptions)
    assert descriptions["status"] == "Show session status"
    assert descriptions["model"] == "Show or change the active model"
    assert "clear" not in descriptions
    assert "exit" not in descriptions
    assert descriptions["team"] == "Create a Team project"
    assert usages["sessions"] == "/sessions [limit]"
    assert usages["init"] == "/init [project|user]"
    assert usages["team"].startswith("/team create")


def test_router_accepts_a_custom_command_catalog() -> None:
    async def handle_custom(context, args):
        return "custom"

    router = SlashCommandRouter(
        (
            SlashCommandInfo(
                "custom",
                "Custom command",
                "/custom",
                handler=handle_custom,
            ),
        )
    )

    assert [info.name for info in router.command_infos()] == ["custom"]


def test_router_rejects_duplicate_command_names_and_aliases() -> None:
    async def handle_command(context, args):
        return "ok"

    with pytest.raises(ValueError, match="Duplicate command name: status"):
        SlashCommandRouter(
            (
                SlashCommandInfo("status", "Status", handler=handle_command),
                SlashCommandInfo("status", "Other status", handler=handle_command),
            )
        )

    with pytest.raises(ValueError, match="Duplicate command alias: x"):
        SlashCommandRouter(
            (
                SlashCommandInfo("one", "One", aliases=("x",), handler=handle_command),
                SlashCommandInfo("two", "Two", aliases=("x",), handler=handle_command),
            )
        )


def test_router_rejects_commands_without_handlers() -> None:
    with pytest.raises(ValueError, match="Command handler is required: status"):
        SlashCommandRouter((SlashCommandInfo("status", "Status"),))


@pytest.mark.asyncio
async def test_sessions_lists_recent_sessions_with_current_marker() -> None:
    class SessionWithRecent(FakeSession):
        session_id = "session_2"

        def __init__(self):
            self.requested_limit = None

        async def list_recent_sessions(self, limit=10):
            self.requested_limit = limit
            return [
                {
                    "id": "session_2",
                    "title": "Current task",
                    "updated_at": "2026-06-02T01:02:03+00:00",
                    "size": {"messages": 4, "tool_calls": 1},
                    "preview": "latest answer",
                },
                {
                    "id": "session_1",
                    "title": "Older task",
                    "updated_at": "2026-06-01T01:02:03+00:00",
                    "size": {"messages": 2, "tool_calls": 0},
                    "preview": "",
                },
            ]

    session = SessionWithRecent()
    result = await SlashCommandRouter().execute("/sessions 5", _context(session=session))

    assert session.requested_limit == 5
    assert "Recent sessions:" in result.text
    assert "session_2 (current)" in result.text
    assert "4 msg, 1 tool" in result.text
    assert "latest answer" in result.text
    assert "/sessions" in result.text
    assert result.display is not None
    assert result.display["type"] == "sessions"
    assert result.display["sessions"][0]["current"] is True
    assert result.display["sessions"][0]["messages"] == 4


@pytest.mark.asyncio
async def test_sessions_reports_no_recent_sessions() -> None:
    result = await SlashCommandRouter().execute("/sessions", _context())

    assert result.text == "No recent sessions."
    assert result.display == {
        "type": "sessions",
        "sessions": [],
        "current_session_id": "session_1",
        "limit": 100,
        "resume_command": "/sessions",
    }


@pytest.mark.asyncio
async def test_sessions_rejects_invalid_limit() -> None:
    result = await SlashCommandRouter().execute("/sessions many", _context())

    assert result.text == "Usage: /sessions [limit]"


@pytest.mark.asyncio
async def test_sessions_handles_unsupported_session_store() -> None:
    class UnsupportedSession:
        session_id = "session_1"
        model = "model_a"

    result = await SlashCommandRouter().execute("/sessions", _context(session=UnsupportedSession()))

    assert result.text == "Sessions are not supported by this session store."


@pytest.mark.asyncio
async def test_unknown_command_returns_friendly_error() -> None:
    result = await SlashCommandRouter().execute("/missing", _context())

    assert "Unknown command: /missing" in result.text
    assert "/help" in result.text


@pytest.mark.asyncio
async def test_team_create_initializes_project_without_handoff(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    session = JsonlSessionStore(session_dir=str(tmp_path / "sessions"), session_id="bootstrap", system_prompt="sys")
    await session.initialize()

    result = await SlashCommandRouter().execute("/team create quant-project", _context(session=session))

    workspace = tmp_path / "agents" / "main-agent"
    meta = json.loads((tmp_path / "sessions" / "bootstrap" / "meta.json").read_text(encoding="utf-8"))
    assert result.display["type"] == "team_create"
    assert result.display["project_id"] == "quant-project"
    assert result.display["main_agent"] == "main-agent"
    assert "session_id" not in result.display
    assert "Switched to" not in result.text
    assert session.session_id == "bootstrap"
    assert Path.cwd() == tmp_path.resolve()
    assert (tmp_path / ".aiteam" / "project.yaml").is_file()
    assert not (tmp_path / ".aiteam" / "organization.yaml").exists()
    assert (workspace / ".aiteam" / "agent.yaml").is_file()
    assert meta["session_type"] == "standalone_project"
    assert "successor_session_id" not in meta
    assert "project_id" not in meta
    assert "owner_agent_id" not in meta


@pytest.mark.asyncio
async def test_status_shows_session_model_debug_and_message_count() -> None:
    result = await SlashCommandRouter().execute("/status", _context())

    assert "Session: session_1" in result.text
    assert "Model: model_a" in result.text
    assert "Debug: true" in result.text
    assert "Messages: 2" in result.text
    assert result.display is not None
    assert result.display["type"] == "status"
    assert result.display["session"] == "session_1"
    assert result.display["debug"] is True


@pytest.mark.asyncio
async def test_status_excludes_skill_snapshot_messages_from_count() -> None:
    class SnapshotSession(FakeSession):
        async def get_messages_slice(self):
            return [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hello"},
                {
                    "role": "user",
                    "content": "<skill_content>private body</skill_content>",
                    "_rind_meta": {"kind": "skill_snapshot"},
                },
            ]

    result = await SlashCommandRouter().execute("/status", _context(SnapshotSession()))

    assert result.display["messages"] == "2"
    assert "Messages: 2" in result.text


@pytest.mark.asyncio
async def test_status_rejects_extra_args() -> None:
    result = await SlashCommandRouter().execute("/status now", _context())

    assert result.text == "Usage: /status"


@pytest.mark.asyncio
async def test_status_shows_git_branch(monkeypatch) -> None:
    class FakeGitProvider:
        def __init__(self, *args, **kwargs):
            pass

        def current(self):
            return GitPromptStatus(branch="main", dirty=True)

    monkeypatch.setattr("agent.runtime.server.commands.git_status.GitPromptStatusProvider", FakeGitProvider)

    result = await SlashCommandRouter().execute("/status", _context())

    assert "Git: main*" in result.text


def test_git_commands_do_not_inherit_runtime_stdin(monkeypatch, tmp_path) -> None:
    from agent.runtime.server.commands import diagnostics, git_status

    calls = []

    def fake_run(*args, **kwargs):
        calls.append(kwargs)
        return type("Completed", (), {"returncode": 0, "stdout": "main\n"})()

    monkeypatch.setattr(git_status.subprocess, "run", fake_run)

    assert git_status._run_git(["rev-parse", "--abbrev-ref", "HEAD"], str(tmp_path)) == "main"
    assert diagnostics._run_git(["rev-parse", "--abbrev-ref", "HEAD"]) == "main"
    assert len(calls) == 2
    assert calls[0]["stdin"] is subprocess.DEVNULL
    assert calls[1]["stdin"] is subprocess.DEVNULL


@pytest.mark.asyncio
async def test_status_shows_latest_sampling_usage() -> None:
    class UsageSession(FakeSession):
        async def get_latest_sampling_usage(self):
            return {
                "input_tokens": 121300,
                "context_window_tokens": 258400,
                "context_usage_percent": 121300 / 258400,
                "cached_input_tokens": 98700,
                "cache_hit_rate": 98700 / 121300,
                "output_tokens": 2100,
            }

    result = await SlashCommandRouter().execute("/status", _context(session=UsageSession()))

    assert "Last sampling:" in result.text
    assert "input: 121.3k / 258.4k" in result.text
    assert "cached: 98.7k (81.4%)" in result.text
    assert result.display is not None
    assert result.display["usage"][0]["label"] == "Last sampling:"
    assert result.display["usage"][0]["input_tokens"] == 121300


@pytest.mark.asyncio
async def test_status_labels_assistant_and_compact_usage_separately() -> None:
    class UsageSession(FakeSession):
        async def get_latest_assistant_sampling_usage(self):
            return {
                "sampling_kind": "assistant",
                "input_tokens": 121300,
                "context_window_tokens": 258400,
                "context_usage_percent": 121300 / 258400,
                "cached_input_tokens": 98700,
                "cache_hit_rate": 98700 / 121300,
                "output_tokens": 2100,
            }

        async def get_latest_sampling_usage(self):
            return {
                "sampling_kind": "compact",
                "input_tokens": 37000,
                "context_window_tokens": 258400,
                "context_usage_percent": 37000 / 258400,
                "cached_input_tokens": 0,
                "cache_hit_rate": 0,
                "output_tokens": 900,
            }

    result = await SlashCommandRouter().execute("/status", _context(session=UsageSession()))

    assert "Assistant sampling:" in result.text
    assert "Latest request (compact):" in result.text
    assert "input: 121.3k / 258.4k" in result.text
    assert "input: 37.0k / 258.4k" in result.text


@pytest.mark.asyncio
async def test_status_tolerates_invalid_sampling_usage() -> None:
    class UsageSession(FakeSession):
        async def get_latest_sampling_usage(self):
            return {
                "input_tokens": "bad",
                "context_window_tokens": object(),
                "context_usage_percent": "bad",
                "cached_input_tokens": -5,
                "cache_hit_rate": None,
                "output_tokens": None,
            }

    result = await SlashCommandRouter().execute("/status", _context(session=UsageSession()))

    assert "Last sampling:" in result.text
    assert "input: 0 (0.0%)" in result.text
    assert "cached: 0 (0.0%)" in result.text
    assert "output: 0" in result.text


@pytest.mark.asyncio
async def test_status_does_not_show_recent_tools() -> None:
    class ToolSession(FakeSession):
        def __init__(self):
            self.tool_records_called = False

        async def get_tool_records(self, limit=None, call_ids=None):
            self.tool_records_called = True
            return [
                {
                    "name": "bash",
                    "ok": True,
                    "ts_end": "2026-06-02T01:02:03.000000+00:00",
                    "meta": {"exit_code": 0},
                },
                {
                    "name": "read_file",
                    "ok": False,
                    "error_type": "FileNotFoundError",
                    "ts_end": "2026-06-02T01:03:04.000000+00:00",
                    "meta": {"stdout_size": 1200},
                },
            ]

    session = ToolSession()
    result = await SlashCommandRouter().execute("/status", _context(session=session))

    assert session.tool_records_called is False
    assert "Status:" in result.text
    assert "Recent tools:" not in result.text
    assert "bash ok" not in result.text


@pytest.mark.asyncio
async def test_config_does_not_leak_api_key(monkeypatch) -> None:
    monkeypatch.setattr(Config, "OPENAI_API_KEY", "secret-value")
    monkeypatch.setattr(Config, "OPENAI_API_BASE", "https://example.com/v1")
    monkeypatch.setattr(Config, "DEFAULT_MODEL", "test-model")
    monkeypatch.setattr(Config, "MODEL_REASONING_EFFORT", "xhigh")
    monkeypatch.setattr(Config, "SETTINGS_PATH", r"C:\Users\admin\.rind\settings.json")
    monkeypatch.setattr(Config, "SETTINGS_EXISTS", True)

    result = await SlashCommandRouter().execute("/config", _context())

    assert "apiKey: set" in result.text
    assert "baseUrl: https://example.com/v1" in result.text
    assert "model: test-model" in result.text
    assert "secret-value" not in result.text
    assert result.display is not None
    assert result.display["type"] == "config"
    assert {"label": "apiKey", "value": "set"} in result.display["entries"]


@pytest.mark.asyncio
async def test_login_mentions_shared_settings_path() -> None:
    result = await SlashCommandRouter().execute("/login", _context())

    assert "~/.rind" in result.text
    assert "settings.json" in result.text


@pytest.mark.asyncio
async def test_doctor_reports_setup_without_leaking_api_key(monkeypatch, tmp_path) -> None:
    class SessionWithRoot(FakeSession):
        session_root = tmp_path / "sessions"

    monkeypatch.setattr(Config, "OPENAI_API_KEY", "secret-value")
    monkeypatch.setattr(Config, "OPENAI_API_BASE", "https://example.com/v1")
    monkeypatch.setattr(Config, "DEFAULT_MODEL", "test-model")
    monkeypatch.setattr(Config, "SETTINGS_PATH", str(tmp_path / "settings.json"))
    monkeypatch.setattr(Config, "SETTINGS_EXISTS", True)

    result = await SlashCommandRouter().execute("/doctor", _context(session=SessionWithRoot()))

    assert "Doctor:" in result.text
    assert "API key: set" in result.text
    assert "Model: test-model" in result.text
    assert "Session store:" in result.text
    assert "Context window" not in result.text
    assert "secret-value" not in result.text
    assert result.display is not None
    assert result.display["type"] == "doctor"
    assert any(check["name"] == "API key" for check in result.display["checks"])


@pytest.mark.asyncio
async def test_doctor_rejects_extra_args() -> None:
    result = await SlashCommandRouter().execute("/doctor now", _context())

    assert result.text == "Usage: /doctor"


@pytest.mark.asyncio
async def test_model_set_updates_session_without_changing_default_settings(tmp_path, monkeypatch) -> None:
    path = tmp_path / ".rind" / "settings.json"
    path.parent.mkdir()
    path.write_text(
        json.dumps({"model": "model_a", "apiKey": "secret-value"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    Config.reload()
    runtime = FakeRuntime()
    session = FakeSession()

    async def update_model(model):
        session.model = model

    session.update_model = update_model
    context = SlashCommandContext(runtime=runtime, session=session, debug=True)

    result = await SlashCommandRouter().execute("/model set model_b", context)
    data = json.loads(path.read_text(encoding="utf-8"))

    assert "Session model updated." in result.text
    assert "session model: model_b" in result.text
    assert "default model: model_a (unchanged)" in result.text
    assert "active session: updated" in result.text
    assert data["model"] == "model_a"
    assert data["apiKey"] == "secret-value"
    assert Config.DEFAULT_MODEL == "model_a"
    assert session.model == "model_b"
    assert runtime.model == "model_b"
    assert "secret-value" not in result.text


@pytest.mark.asyncio
async def test_model_rejects_invalid_set_args() -> None:
    result = await SlashCommandRouter().execute("/model set", _context())

    assert result.text == "Usage: /model or /model set <model>"


@pytest.mark.asyncio
async def test_compact_calls_runtime_compact_context() -> None:
    session = FakeSession()
    runtime = FakeRuntime()
    context = SlashCommandContext(runtime=runtime, session=session, debug=True)
    result = await SlashCommandRouter().execute("/compact", context)

    assert runtime.compact_called is True
    assert "Compact complete." in result.text
    assert "runtime_compact_1" in result.text
    assert "tool calls: 0" in result.text


@pytest.mark.asyncio
async def test_compact_returns_friendly_message_for_empty_session() -> None:
    class EmptySession(FakeSession):
        async def get_messages_slice(self):
            return [{"role": "system", "content": "sys"}]

    runtime = FakeRuntime()
    context = SlashCommandContext(runtime=runtime, session=EmptySession(), debug=True)
    result = await SlashCommandRouter().execute("/compact", context)

    assert runtime.compact_called is False
    assert result.text == "Not enough messages to compact. Send a message first."



@pytest.mark.asyncio
async def test_skill_lists_project_skill(tmp_path, monkeypatch) -> None:
    skill_dir = tmp_path / ".rind" / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo skill\ntriggers: []\n---\n\nBody\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    result = await SlashCommandRouter().execute("/skill", _context())

    assert "demo [project]" in result.text
    assert "Demo skill" in result.text
    assert result.display is not None
    assert result.display["type"] == "skills"
    assert any(skill["name"] == "demo" for skill in result.display["skills"])


@pytest.mark.asyncio
async def test_skill_lists_user_skill_from_rind_home(tmp_path, monkeypatch) -> None:
    rind_home = tmp_path / "rind-home"
    workspace = tmp_path / "workspace"
    skill_dir = rind_home / "skills" / "demo"
    workspace.mkdir()
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: User demo skill\ntriggers: []\n---\n\nBody\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("RIND_HOME", str(rind_home))

    result = await SlashCommandRouter().execute("/skill", _context())

    assert "demo [user]" in result.text
    assert "User demo skill" in result.text
    assert str(skill_dir / "SKILL.md") in result.text


@pytest.mark.asyncio
async def test_skill_lists_project_skill_from_cwd_not_parent_git_root(tmp_path, monkeypatch) -> None:
    project = tmp_path / "project"
    nested = project / "src"
    nested_skill_dir = nested / ".rind" / "skills" / "nested"
    parent_skill_dir = project / ".rind" / "skills" / "parent"
    nested_skill_dir.mkdir(parents=True)
    parent_skill_dir.mkdir(parents=True)
    (project / ".git").mkdir()
    (nested_skill_dir / "SKILL.md").write_text(
        "---\nname: nested\ndescription: Nested skill\ntriggers: []\n---\n\nBody\n",
        encoding="utf-8",
    )
    (parent_skill_dir / "SKILL.md").write_text(
        "---\nname: parent\ndescription: Parent skill\ntriggers: []\n---\n\nBody\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(nested)

    result = await SlashCommandRouter().execute("/skill", _context())

    assert "nested [project]" in result.text
    assert "Nested skill" in result.text
    assert "parent [project]" not in result.text


@pytest.mark.asyncio
async def test_skill_list_rescans_without_updating_session_catalog(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    skill_dir = tmp_path / ".rind" / "skills" / "first"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: first\ndescription: First skill\n---\n\nBody\n",
        encoding="utf-8",
    )
    repository = SkillRepository(project_root=str(tmp_path), user_skill_dir=str(tmp_path / "user-skills"))

    class CatalogSession(FakeSession):
        def __init__(self):
            self.catalog = [{"name": "first", "description": "First skill", "scope": "project"}]
            self.set_calls = 0

        async def get_skill_catalog(self):
            return list(self.catalog)

        async def set_skill_catalog(self, entries):
            self.set_calls += 1
            self.catalog = list(entries)

    session = CatalogSession()
    runtime = FakeRuntime()
    runtime.skill_repository = repository
    context = SlashCommandContext(runtime=runtime, session=session, debug=True)
    router = SlashCommandRouter()

    first = await router.execute("/skill list", context)
    assert "first [project]" in first.text
    assert session.set_calls == 0

    new_skill_dir = tmp_path / ".rind" / "skills" / "second"
    new_skill_dir.mkdir(parents=True)
    (new_skill_dir / "SKILL.md").write_text(
        "---\nname: second\ndescription: Second skill\n---\n\nBody\n",
        encoding="utf-8",
    )

    second = await router.execute("/skill", context)

    assert "first [project]" in second.text
    assert "second [project]" in second.text
    assert [entry["name"] for entry in session.catalog] == ["first"]
    assert session.set_calls == 0


@pytest.mark.asyncio
async def test_init_project_returns_turn_payload(tmp_path, monkeypatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()
    monkeypatch.chdir(project)

    result = await SlashCommandRouter().execute("/init", _context())

    assert "Initializing project RIND.md" in result.text
    assert result.next_prompt["input"].startswith("Initialize project RIND.md")
    assert str(project / "RIND.md") in result.next_prompt["input"]
    assert result.next_prompt["transient_system_messages"]
    prompt = result.next_prompt["transient_system_messages"][0]["content"]
    assert "project-level Rind context document" in prompt
    assert str(project / "RIND.md") in prompt
    assert "Do not modify the other RIND.md level." in prompt


@pytest.mark.asyncio
async def test_init_project_uses_cwd_not_parent_git_root(tmp_path, monkeypatch) -> None:
    project = tmp_path / "project"
    nested = project / "src"
    nested.mkdir(parents=True)
    (project / ".git").mkdir()
    monkeypatch.chdir(nested)

    result = await SlashCommandRouter().execute("/init project", _context())

    assert str(nested / "RIND.md") in result.next_prompt["input"]
    assert str(project / "RIND.md") not in result.next_prompt["input"]
    prompt = result.next_prompt["transient_system_messages"][0]["content"]
    assert str(nested / "RIND.md") in prompt


@pytest.mark.asyncio
async def test_init_project_accepts_string_workspace_root(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(tmp_path)
    context = _context()
    context.workspace_root = str(workspace)

    result = await SlashCommandRouter().execute("/init project", context)

    assert result.next_prompt is not None
    assert str(workspace / "RIND.md") in result.next_prompt["input"]


@pytest.mark.asyncio
async def test_init_user_returns_turn_payload(tmp_path, monkeypatch) -> None:
    user_home = tmp_path / "home"
    user_home.mkdir()
    monkeypatch.setenv("RIND_HOME", str(user_home))

    result = await SlashCommandRouter().execute("/init user", _context())

    assert "Initializing user RIND.md" in result.text
    assert result.next_prompt["input"].startswith("Initialize user RIND.md")
    assert str(user_home / "RIND.md") in result.next_prompt["input"]
    prompt = result.next_prompt["transient_system_messages"][0]["content"]
    assert "user-level Rind context document" in prompt
    assert "Do not copy project facts into the user-level file." in prompt


@pytest.mark.asyncio
async def test_init_rejects_invalid_scope() -> None:
    result = await SlashCommandRouter().execute("/init all", _context())

    assert result.text == "Usage: /init [project|user]"
    assert result.next_prompt is None


def main() -> int:
    test_router_exposes_sorted_command_names()
    test_router_exposes_command_descriptions()
    asyncio.run(test_help_returns_command_list())
    asyncio.run(test_help_returns_command_specific_usage())
    asyncio.run(test_help_reports_unknown_command())
    asyncio.run(test_help_rejects_too_many_args())
    asyncio.run(test_unknown_command_returns_friendly_error())
    asyncio.run(test_status_shows_session_model_debug_and_message_count())
    asyncio.run(test_status_shows_latest_sampling_usage())
    asyncio.run(test_status_labels_assistant_and_compact_usage_separately())
    asyncio.run(test_status_does_not_show_recent_tools())
    asyncio.run(test_model_rejects_invalid_set_args())
    asyncio.run(test_compact_calls_runtime_compact_context())
    asyncio.run(test_compact_passes_cancellation_token_to_runtime())
    print("Runtime Server command tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
