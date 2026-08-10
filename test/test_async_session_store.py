import shutil
import tempfile
import pytest
import os
import asyncio
import sys
import json
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.domain.compaction import COMPACT_CONTINUATION_USER_CONTENT
from agent.domain.message_boundary import validate_model_message_boundary
from agent.infrastructure.tools.builtin.planning import update_plan

@pytest.fixture
def temp_session_dir():
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)

@pytest.mark.asyncio
async def test_async_session_store_facade(temp_session_dir):
    async_store = JsonlSessionStore(session_dir=temp_session_dir)

    await async_store.initialize()

    assert async_store.session_id is not None
    session_base = Path(temp_session_dir) / async_store.session_id
    meta = json.loads((session_base / "meta.json").read_text(encoding="utf-8"))
    assert meta["schema_version"] == "2.0"
    assert (session_base / "messages.jsonl").exists()
    assert (session_base / "tool_calls.jsonl").exists()
    removed_files = ["conversation_" + "summaries.jsonl", "tool_call_" + "summaries.jsonl"]
    for removed in removed_files:
        assert not (session_base / removed).exists()
    assert not (session_base / ("snap" + "shots")).exists()
    assert not (session_base / "compactions.jsonl").exists()

    # Test persistence
    await async_store.persist_message("user", "Hello World")

    # Load and verify
    messages = await async_store.load_messages()
    assert len(messages) == 1
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == "Hello World"

    # Test concurrency isolation informally
    async def write_msgs(role, n):
        for i in range(n):
            await async_store.persist_message(role, f"msg_{i}")

    await asyncio.gather(
        write_msgs("assistant", 5),
        write_msgs("system", 5)
    )

    messages = await async_store.load_messages()
    assert len(messages) == 11 # 1 user + 5 assistant + 5 system


@pytest.mark.asyncio
async def test_empty_session_is_removed_with_index_entry(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir)
    await store.initialize()
    session_base = Path(temp_session_dir) / store.session_id

    await store.discard_if_empty()

    assert not session_base.exists()
    index = json.loads((Path(temp_session_dir) / "index.json").read_text(encoding="utf-8"))
    assert not any(entry.get("id") == store.session_id for entry in index["sessions"])


@pytest.mark.asyncio
async def test_session_with_user_message_is_kept(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir)
    await store.initialize()
    await store.persist_message("user", "keep this session")
    session_base = Path(temp_session_dir) / store.session_id

    await store.discard_if_empty()

    assert session_base.exists()
    index = json.loads((Path(temp_session_dir) / "index.json").read_text(encoding="utf-8"))
    assert any(entry.get("id") == store.session_id for entry in index["sessions"])


@pytest.mark.asyncio
async def test_async_session_store_persists_and_reloads_turn_state(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir)
    await store.initialize()

    await store.persist_turn_state("turn-1", "completed", "2026-05-08T00:00:00Z")
    assert await store.get_turn_state() == {
        "turn_id": "turn-1",
        "status": "completed",
        "ts": "2026-05-08T00:00:00Z",
    }

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id=store.session_id)
    await resumed.initialize()
    assert await resumed.get_turn_state() == await store.get_turn_state()


def test_resolve_session_root_uses_rind_home(monkeypatch, tmp_path):
    rind_home = tmp_path / ".rind"
    monkeypatch.setenv("RIND_HOME", str(rind_home))

    root = JsonlSessionStore.resolve_session_root()

    assert root == os.path.abspath(str(rind_home / "sessions"))


def test_resolve_session_root_uses_explicit_session_dir(tmp_path):
    session_dir = tmp_path / "custom_sessions"

    root = JsonlSessionStore.resolve_session_root(str(session_dir))

    assert root == os.path.abspath(str(session_dir))


@pytest.mark.asyncio
async def test_session_store_rejects_invalid_session_ids(temp_session_dir, tmp_path):
    invalid_ids = ["../escape", r"a\b", "a/b", "bad id", "C:drive", "..", ""]

    for session_id in invalid_ids:
        store = JsonlSessionStore(session_dir=temp_session_dir, session_id=session_id)
        with pytest.raises(ValueError, match="Invalid session id"):
            await store.initialize()

    assert not (Path(temp_session_dir).parent / "escape").exists()


@pytest.mark.asyncio
async def test_switch_session_rebinds_store_and_restores_target_state(temp_session_dir):
    first = JsonlSessionStore(session_dir=temp_session_dir, session_id="first", model="model-a")
    await first.initialize()
    await first.persist_message("user", "first message")
    await first.persist_sampling_usage({"sampling_kind": "assistant", "input_tokens": 10})

    second = JsonlSessionStore(session_dir=temp_session_dir, session_id="second", model="model-b")
    await second.initialize()
    await second.persist_message("user", "second message")
    await second.persist_sampling_usage({"sampling_kind": "assistant", "input_tokens": 20})

    result = await first.switch_session("second")

    assert first.session_id == "second"
    assert first.model == "model-b"
    assert result["session_id"] == "second"
    assert result["model"] == "model-b"
    assert result["usage"]["input_tokens"] == 20
    assert [message["content"] for message in await first.get_messages_slice() if message["role"] == "user"] == [
        "second message"
    ]


@pytest.mark.asyncio
async def test_resume_session_uses_model_from_meta_over_constructor_default(temp_session_dir):
    original = JsonlSessionStore(session_dir=temp_session_dir, session_id="session", model="settings-model")
    await original.initialize()
    await original.update_model("meta-model")

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id="session", model="settings-model")
    await resumed.initialize()

    assert resumed.model == "meta-model"


@pytest.mark.asyncio
async def test_switch_session_does_not_create_missing_target(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, session_id="first")
    await store.initialize()

    with pytest.raises(ValueError, match="Session not found"):
        await store.switch_session("missing")

    assert store.session_id == "first"
    assert not (Path(temp_session_dir) / "missing").exists()


@pytest.mark.asyncio
async def test_create_session_rebinds_store_and_indexes_new_session(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, session_id="first", model="model-a")
    await store.initialize()
    await store.persist_message("user", "existing message")

    result = await store.create_session()

    assert result["session_id"] != "first"
    assert store.session_id == result["session_id"]
    assert [message for message in await store.get_messages_slice() if message["role"] != "system"] == []
    assert (Path(temp_session_dir) / result["session_id"] / "meta.json").is_file()


@pytest.mark.asyncio
async def test_switch_session_rejects_corrupt_target_and_keeps_current(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, session_id="first")
    await store.initialize()
    corrupt = Path(temp_session_dir) / "corrupt"
    corrupt.mkdir()
    (corrupt / "meta.json").write_text("{broken", encoding="utf-8")

    with pytest.raises(ValueError, match="Corrupted JSON file"):
        await store.switch_session("corrupt")

    assert store.session_id == "first"


@pytest.mark.asyncio
async def test_session_store_persists_goal_lifecycle(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, session_id="goal-session")
    await store.initialize()

    assert await store.get_goal() is None
    goal = await store.set_goal("finish the release")
    assert goal == {"objective": "finish the release", "status": "active"}
    assert await store.set_goal_status("paused") == {"objective": "finish the release", "status": "paused"}

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id="goal-session")
    await resumed.initialize()
    assert await resumed.get_goal() == {"objective": "finish the release", "status": "paused"}

    await resumed.clear_goal()
    assert await resumed.get_goal() is None


@pytest.mark.asyncio
async def test_session_store_rejects_corrupt_goal_metadata(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, session_id="goal-session")
    await store.initialize()
    meta_path = Path(temp_session_dir) / "goal-session" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["goal"] = {"objective": "missing status"}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    with pytest.raises(ValueError, match="Corrupted goal"):
        await JsonlSessionStore(session_dir=temp_session_dir, session_id="goal-session").initialize()


@pytest.mark.asyncio
async def test_session_workspace_root_uses_cwd_not_parent_git_root(tmp_path, monkeypatch):
    project = tmp_path / "project"
    nested = project / "src"
    session_root = tmp_path / "sessions"
    nested.mkdir(parents=True)
    (project / ".git").mkdir()
    monkeypatch.chdir(nested)

    store = JsonlSessionStore(session_dir=str(session_root))
    await store.initialize()

    meta_path = session_root / store.session_id / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["workspace_root"] == os.path.normcase(os.path.realpath(str(nested.resolve())))
    assert meta["workspace_root"] != os.path.normcase(os.path.realpath(str(project.resolve())))


@pytest.mark.asyncio
async def test_session_records_agent_binding_and_indexes_it(tmp_path):
    session_root = tmp_path / "sessions"
    workspace = tmp_path / "agents" / "factor-agent"
    workspace.mkdir(parents=True)

    store = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="factor_session",
        workspace_root=str(workspace),
        project_id="quant-project",
        owner_agent_id="factor-agent",
        session_type="direct_agent_chat",
    )
    await store.initialize()

    meta = json.loads((session_root / "factor_session" / "meta.json").read_text(encoding="utf-8"))
    assert meta["project_id"] == "quant-project"
    assert meta["owner_agent_id"] == "factor-agent"
    assert meta["session_type"] == "direct_agent_chat"
    assert meta["workspace_root"] == os.path.normcase(os.path.realpath(str(workspace)))
    index = json.loads((session_root / "index.json").read_text(encoding="utf-8"))
    assert index["sessions"][0]["owner_agent_id"] == "factor-agent"


@pytest.mark.asyncio
async def test_session_rejects_mismatched_agent_binding(tmp_path):
    session_root = tmp_path / "sessions"
    first_workspace = tmp_path / "agents" / "factor-agent"
    second_workspace = tmp_path / "agents" / "main-agent"
    first_workspace.mkdir(parents=True)
    second_workspace.mkdir(parents=True)

    first = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="team_session",
        workspace_root=str(first_workspace),
        owner_agent_id="factor-agent",
        session_type="direct_agent_chat",
    )
    await first.initialize()

    second = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="team_session",
        workspace_root=str(second_workspace),
        owner_agent_id="main-agent",
        session_type="direct_agent_chat",
    )
    with pytest.raises(ValueError, match="immutable"):
        await second.initialize()


@pytest.mark.asyncio
async def test_session_keeps_its_original_delegation_parent(tmp_path):
    session_root = tmp_path / "sessions"
    workspace = tmp_path / "agents" / "factor-agent"
    workspace.mkdir(parents=True)

    first = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="factor_session",
        workspace_root=str(workspace),
        project_id="quant-project",
        owner_agent_id="factor-agent",
        session_type="delegated_task",
        parent_session_id="bootstrap",
    )
    await first.initialize()

    second = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="factor_session",
        workspace_root=str(workspace),
        project_id="quant-project",
        owner_agent_id="factor-agent",
        session_type="delegated_task",
        parent_session_id="other-bootstrap",
    )
    await second.initialize()

    meta = json.loads((session_root / "factor_session" / "meta.json").read_text(encoding="utf-8"))
    assert meta["parent_session_id"] == "bootstrap"

@pytest.mark.asyncio
async def test_resume_latest_and_recent_sessions_ignore_invalid_index_ids(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    session_root = tmp_path / "sessions"
    store = JsonlSessionStore(session_dir=str(session_root), session_id="valid_session")
    await store.initialize()
    await store.persist_message("user", "keep this session")

    empty = JsonlSessionStore(session_dir=str(session_root), session_id="empty_session")
    await empty.initialize()

    meta = json.loads((session_root / "valid_session" / "meta.json").read_text(encoding="utf-8"))
    index_path = session_root / "index.json"
    index_path.write_text(
        json.dumps(
            {
                "sessions": [
                    {
                        "id": "../escape",
                        "updated_at": "2099-01-01T00:00:00+00:00",
                        "workspace_root": meta["workspace_root"],
                    },
                    {
                        "id": "empty_session",
                        "updated_at": "2099-01-01T00:00:00+00:00",
                        "size": {"messages": 1, "tool_calls": 0},
                        "workspace_root": meta["workspace_root"],
                    },
                    {
                        "id": "valid_session",
                        "updated_at": "2026-01-01T00:00:00+00:00",
                        "size": {"messages": 2, "tool_calls": 0},
                        "workspace_root": meta["workspace_root"],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    resumed = JsonlSessionStore(session_dir=str(session_root), resume_latest=True)
    await resumed.initialize()
    recent = await resumed.list_recent_sessions(limit=10)

    assert resumed.session_id == "valid_session"
    assert [item["id"] for item in recent] == ["valid_session"]
    assert not (tmp_path / "escape").exists()


@pytest.mark.asyncio
async def test_list_recent_sessions_only_returns_current_workspace(tmp_path):
    session_root = tmp_path / "sessions"
    workspace_a = tmp_path / "workspace-a"
    workspace_b = tmp_path / "workspace-b"
    workspace_a.mkdir()
    workspace_b.mkdir()

    store_a = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="session_a",
        workspace_root=str(workspace_a),
    )
    await store_a.initialize()
    await store_a.persist_message("user", "session in workspace a")
    await store_a.persist_message("assistant", "reply in workspace a")

    store_b = JsonlSessionStore(
        session_dir=str(session_root),
        session_id="session_b",
        workspace_root=str(workspace_b),
    )
    await store_b.initialize()
    await store_b.persist_message("user", "session in workspace b")
    await store_b.persist_message("assistant", "reply in workspace b")

    recent_a = await store_a.list_recent_sessions(limit=10)
    recent_b = await store_b.list_recent_sessions(limit=10)

    assert [item["id"] for item in recent_a] == ["session_a"]
    assert [item["id"] for item in recent_b] == ["session_b"]


def test_session_files_read_jsonl_waits_for_active_writer(tmp_path):
    path = tmp_path / "messages.jsonl"
    files = SessionFiles()

    with files._get_lock_for_path(str(path)):
        path.write_text('{"role": "user"', encoding="utf-8")
        read_result = []

        thread = threading.Thread(
            target=lambda: read_result.extend(files.read_jsonl(str(path))),
        )
        thread.start()
        time.sleep(0.1)

        assert thread.is_alive()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(', "content": "complete"}\n')

    thread.join(timeout=2)

    assert not thread.is_alive()
    assert read_result == [{"role": "user", "content": "complete"}]


def test_session_files_load_json_waits_for_active_writer(tmp_path):
    path = tmp_path / "meta.json"
    files = SessionFiles()

    with files._get_lock_for_path(str(path)):
        path.write_text('{"schema_version": ', encoding="utf-8")
        read_result = []

        thread = threading.Thread(
            target=lambda: read_result.append(files.load_json(str(path))),
        )
        thread.start()
        time.sleep(0.1)

        assert thread.is_alive()
        with path.open("a", encoding="utf-8") as handle:
            handle.write('"2.0"}')

    thread.join(timeout=2)

    assert not thread.is_alive()
    assert read_result == [{"schema_version": "2.0"}]


def test_session_files_load_json_reports_corrupt_json(tmp_path):
    path = tmp_path / "meta.json"
    path.write_text("{", encoding="utf-8")
    files = SessionFiles()

    with pytest.raises(ValueError, match="Corrupted JSON file"):
        files.load_json(str(path))


def test_session_files_write_json_removes_tmp_on_replace_failure(monkeypatch, tmp_path):
    path = tmp_path / "meta.json"
    files = SessionFiles()
    real_replace = os.replace

    def fail_after_tmp(src, dst):
        if str(dst) == str(path):
            raise OSError("replace failed")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", fail_after_tmp)

    with pytest.raises(OSError, match="replace failed"):
        files.write_json(str(path), {"schema_version": "2.0"})

    leftovers = list(tmp_path.glob("meta.json.*.tmp"))
    assert leftovers == []


@pytest.mark.asyncio
async def test_persist_tool_call_writes_model_content(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="fixed model content",
        model_content_format="tool_result_v2",
        model_content_policy={"truncated": False},
    )
    await store.persist_message("tool", "", tool_call_id="call_1", tool_name="bash")

    records = await store.get_tool_records(call_ids=["call_1"])
    messages = await store.get_messages_slice()

    assert records[0]["model_content"] == "fixed model content"
    assert "artifact_ref" not in records[0]
    tool_message = next(message for message in messages if message.get("role") == "tool")
    assert tool_message["content"] == "fixed model content"


@pytest.mark.asyncio
async def test_message_projector_deduplicates_tool_messages(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="fixed model content",
        model_content_format="tool_result_v2",
        model_content_policy={"truncated": False},
    )
    await store.persist_message("tool", "", tool_call_id="call_1", tool_name="bash")

    messages = await store.get_messages_slice()
    tool_messages = [message for message in messages if message.get("role") == "tool"]

    assert len(tool_messages) == 1
    assert tool_messages[0] == {"role": "tool", "tool_call_id": "call_1", "content": "fixed model content"}


@pytest.mark.asyncio
async def test_get_messages_slice_preserves_empty_tool_arguments(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "run the tool")
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "list_files"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="list_files",
        parsed_args={},
        raw_args="",
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "list_files", "data": "empty"}),
        model_content="empty result",
    )
    await store.persist_message("tool", "", tool_call_id="call_1", tool_name="list_files")

    messages = await store.get_messages_slice()

    assert messages[2] == {
        "role": "assistant",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "list_files", "arguments": ""},
            }
        ],
    }
    assert messages[3] == {"role": "tool", "tool_call_id": "call_1", "content": "empty result"}
    assert validate_model_message_boundary(messages).ok


@pytest.mark.asyncio
async def test_update_plan_tool_args_are_projected_into_next_context(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    plan = [{"step": "Run plan projector regression", "status": "in_progress"}]
    tool_result = update_plan(plan)
    raw_args = json.dumps({"plan": plan}, ensure_ascii=False)

    await store.persist_message("user", "track this work")
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "plan_1", "name": "update_plan"}]})
    await store.persist_tool_call(
        call_id="plan_1",
        name="update_plan",
        parsed_args={"plan": plan},
        raw_args=raw_args,
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=tool_result,
        model_content=tool_result,
    )
    await store.persist_message("tool", "", tool_call_id="plan_1", tool_name="update_plan")

    messages = await store.get_messages_slice()
    assistant = next(message for message in messages if message.get("role") == "assistant" and message.get("tool_calls"))
    tool = next(message for message in messages if message.get("role") == "tool")
    arguments = assistant["tool_calls"][0]["function"]["arguments"]
    assert json.loads(arguments) == {"plan": plan}
    assert json.loads(tool["content"])["data"] == "Plan updated"


@pytest.mark.asyncio
async def test_get_messages_slice_recovers_missing_tool_message_from_record(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="recovered model content",
        model_content_format="tool_result_v2",
        model_content_policy={"truncated": False},
    )

    messages = await store.get_messages_slice()

    assert messages == [
        {"role": "system", "content": "sys"},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "bash", "arguments": '{"command":"date"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "recovered model content"},
    ]


@pytest.mark.asyncio
async def test_get_messages_slice_skips_interrupted_tool_call(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message(
        "assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]}
    )

    messages = await store.get_messages_slice()

    assert messages == [{"role": "system", "content": "sys"}]


@pytest.mark.asyncio
async def test_get_messages_slice_matches_numeric_tool_ids_as_strings(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": 123, "name": "bash"}]})
    await store.persist_tool_call(
        call_id="123",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="numeric id content",
        model_content_format="tool_result_v2",
        model_content_policy={"truncated": False},
    )

    messages = await store.get_messages_slice()

    assert messages[1]["tool_calls"][0]["id"] == "123"
    assert messages[2] == {"role": "tool", "tool_call_id": "123", "content": "numeric id content"}


@pytest.mark.asyncio
async def test_get_messages_slice_uses_projection_cache_until_files_change(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "first")

    calls = {"messages": 0, "tools": 0, "compactions": 0}
    original_messages = store._msg_repo.load_messages
    original_tools = store._tool_repo.load_tool_calls
    original_compactions = store._compaction_repo.load_compactions

    def load_messages():
        calls["messages"] += 1
        return original_messages()

    def load_tools():
        calls["tools"] += 1
        return original_tools()

    def load_compactions():
        calls["compactions"] += 1
        return original_compactions()

    store._msg_repo.load_messages = load_messages
    store._tool_repo.load_tool_calls = load_tools
    store._compaction_repo.load_compactions = load_compactions

    first = await store.get_messages_slice()
    first[0]["content"] = "mutated"
    second = await store.get_messages_slice()

    assert second[0] == {"role": "system", "content": "sys"}
    assert calls == {"messages": 1, "tools": 1, "compactions": 1}

    await store.persist_message("user", "second")
    third = await store.get_messages_slice()

    assert third[-1] == {"role": "user", "content": "second"}
    assert calls == {"messages": 2, "tools": 2, "compactions": 2}


@pytest.mark.asyncio
async def test_get_messages_slice_rejects_tool_record_without_model_content(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "legacy", "name": "bash"}]})
    session_base = Path(temp_session_dir) / store.session_id
    legacy_record = {
        "id": "legacy",
        "ts_start": store.now_iso(),
        "ts_end": store.now_iso(),
        "name": "bash",
        "args": {},
        "raw_args": "{}",
        "result": {"ok": True, "tool": "bash", "data": "legacy output"},
    }
    with (session_base / "tool_calls.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(legacy_record, ensure_ascii=False) + "\n")
    await store.persist_message("tool", "", tool_call_id="legacy", tool_name="bash")

    with pytest.raises(ValueError, match="missing model_content"):
        await store.get_messages_slice()


@pytest.mark.asyncio
async def test_persist_tool_call_requires_model_content(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()

    with pytest.raises(ValueError, match="model_content"):
        await store.persist_tool_call(
            call_id="call_missing",
            name="bash",
            parsed_args={},
            raw_args="{}",
            ts_start=store.now_iso(),
            ts_end=store.now_iso(),
            result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw"}),
            model_content="",
        )


@pytest.mark.asyncio
async def test_legacy_session_schema_is_rejected(temp_session_dir):
    session_id = "legacy_session"
    session_base = Path(temp_session_dir) / session_id
    session_base.mkdir(parents=True)
    (session_base / "meta.json").write_text(
        json.dumps(
            {
                "schema_version": "1.1",
                "session_id": session_id,
                "updated_at": "2026-01-01T00:00:00+00:00",
                "message_count": 0,
                "tool_call_count": 0,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    store = JsonlSessionStore(session_dir=temp_session_dir, session_id=session_id)
    with pytest.raises(ValueError, match="Unsupported legacy session schema"):
        await store.initialize()


@pytest.mark.asyncio
async def test_persist_compaction_appends_boundary_without_rewriting_messages(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "old question")
    await store.persist_message("assistant", "old answer")
    before = await store.load_messages()

    record = await store.persist_compaction(
        {
            "id": "compact_1",
            "created_at": store.now_iso(),
            "policy_version": "compact_boundary_v3",
            "source": {
                "message_start_index": 0,
                "message_end_index_exclusive": len(before),
                "tool_call_ids": [],
            },
            "handoff_message": {
                "role": "assistant",
                "content": "Context compacted.\n\n- old question\n- old answer",
            },
        }
    )
    after = await store.load_messages()
    session_base = Path(temp_session_dir) / store.session_id

    assert after[: len(before)] == before
    assert (session_base / "compactions.jsonl").exists()
    assert after[-1]["meta"]["kind"] == "compact_boundary"
    assert after[-1]["meta"]["compact_id"] == record["id"]

    compacted_messages = await store.get_messages_slice()
    assert compacted_messages[0] == {"role": "system", "content": "sys"}
    assert compacted_messages[1] == {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT}
    assert compacted_messages[2]["role"] == "assistant"
    assert compacted_messages[2]["content"].startswith("Context compacted.")
    assert "old question" in compacted_messages[2]["content"]

    await store.persist_message("user", "new question")
    first = await store.get_messages_slice()
    second = await store.get_messages_slice()

    assert first == second
    assert first[-1] == {"role": "user", "content": "new question"}


@pytest.mark.asyncio
async def test_persist_compaction_projects_minimal_replacement_boundary(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "old question")
    await store.persist_message("assistant", "old answer")
    await store.persist_message("user", "current question")
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="tool model content",
        model_content_format="tool_result_v2",
        model_content_policy={"truncated": False},
    )
    await store.persist_message("tool", "", tool_call_id="call_1", tool_name="bash")
    before = await store.load_messages()

    await store.persist_compaction(
        {
            "id": "compact_minimal_boundary",
            "created_at": store.now_iso(),
            "policy_version": "compact_boundary_v3",
            "source": {
                "message_start_index": 0,
                "message_end_index_exclusive": len(before),
                "tool_call_ids": [],
            },
            "continuation_user_message": {
                "role": "user",
                "content": COMPACT_CONTINUATION_USER_CONTENT,
            },
            "handoff_message": {"role": "assistant", "content": "Context compacted."},
        }
    )
    messages = await store.get_messages_slice()

    assert (await store.load_messages())[: len(before)] == before
    assert messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
        {"role": "assistant", "content": "Context compacted."},
    ]
    assert {"role": "user", "content": "old question"} not in messages
    assert {"role": "assistant", "content": "old answer"} not in messages
    assert {"role": "user", "content": "current question"} not in messages
    assert not any(message.get("role") == "tool" for message in messages)


@pytest.mark.asyncio
async def test_orphan_compaction_record_does_not_compact_context(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "keep this question")
    session_base = Path(temp_session_dir) / store.session_id
    orphan = {
        "id": "orphan_compact",
        "created_at": store.now_iso(),
        "handoff_message": {"role": "assistant", "content": "orphan handoff"},
    }
    with (session_base / "compactions.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(orphan, ensure_ascii=False) + "\n")

    messages = await store.get_messages_slice()
    latest = await store.get_latest_compaction()

    assert latest is None
    assert messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "keep this question"},
    ]


@pytest.mark.asyncio
async def test_unmatched_compact_boundary_does_not_truncate_context(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "before broken boundary")
    await store.persist_message("assistant", "", meta={"kind": "compact_boundary", "compact_id": "missing"})
    await store.persist_message("user", "after broken boundary")

    messages = await store.get_messages_slice()
    latest = await store.get_latest_compaction()

    assert latest is None
    assert messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "before broken boundary"},
        {"role": "user", "content": "after broken boundary"},
    ]


@pytest.mark.asyncio
async def test_invalid_compaction_record_does_not_truncate_context(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "before invalid compact")
    session_base = Path(temp_session_dir) / store.session_id
    invalid = {
        "id": "invalid_compact",
        "created_at": store.now_iso(),
        "handoff_message": {"role": "assistant", "content": None},
    }
    with (session_base / "compactions.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(invalid, ensure_ascii=False) + "\n")
    await store.persist_message(
        "assistant",
        "",
        meta={"kind": "compact_boundary", "compact_id": "invalid_compact"},
    )
    await store.persist_message("user", "after invalid compact")

    messages = await store.get_messages_slice()
    latest = await store.get_latest_compaction()

    assert latest is None
    assert messages == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "before invalid compact"},
        {"role": "user", "content": "after invalid compact"},
    ]


@pytest.mark.asyncio
async def test_latest_valid_compact_boundary_survives_newer_broken_boundary(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "old compacted question")
    record = await store.persist_compaction(
        {
            "id": "compact_1",
            "created_at": store.now_iso(),
            "policy_version": "compact_boundary_v3",
            "source": {
                "message_start_index": 0,
                "message_end_index_exclusive": 1,
                "tool_call_ids": [],
            },
            "handoff_message": {
                "role": "assistant",
                "content": "Context compacted.\n\n- old compacted question",
            },
        }
    )
    await store.persist_message("user", "after valid compact")
    await store.persist_message("assistant", "", meta={"kind": "compact_boundary", "compact_id": "missing"})
    await store.persist_message("user", "after broken boundary")

    messages = await store.get_messages_slice()
    latest = await store.get_latest_compaction()

    assert latest is not None
    assert latest["id"] == record["id"]
    assert messages[0] == {"role": "system", "content": "sys"}
    assert messages[1] == {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT}
    assert messages[2]["role"] == "assistant"
    assert messages[2]["content"].startswith("Context compacted.")
    assert {"role": "user", "content": "old compacted question"} not in messages
    assert messages[-2:] == [
        {"role": "user", "content": "after valid compact"},
        {"role": "user", "content": "after broken boundary"},
    ]


@pytest.mark.asyncio
async def test_sampling_usage_and_compact_generation_meta(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()

    usage = {
        "sampling_kind": "assistant",
        "input_tokens": 100,
        "cached_input_tokens": 40,
        "cache_hit_rate": 0.4,
        "output_tokens": 25,
        "total_tokens": 125,
        "context_usage_percent": 0.1,
        "context_window_tokens": 1000,
        "anchor": {
            "local_estimated_input_tokens": 130,
            "local_estimated_chars": 520,
            "context_message_count": 3,
            "compact_generation": 1,
        },
    }
    await store.persist_sampling_usage(usage)

    latest = await store.get_latest_sampling_usage()
    latest_assistant = await store.get_latest_assistant_sampling_usage()

    assert latest["input_tokens"] == 100
    assert latest_assistant["input_tokens"] == 100
    assert latest_assistant["anchor"]["local_estimated_input_tokens"] == 130
    assert latest["cached_input_tokens"] == 40
    assert await store.get_compact_generation() == 1

    await store.persist_compaction({"handoff_message": {"role": "assistant", "content": "handoff"}})

    assert await store.get_compact_generation() == 2
    assert await store.get_latest_assistant_sampling_usage() is None


@pytest.mark.asyncio
async def test_sampling_usage_keeps_latest_assistant_usage_when_compact_usage_arrives(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()

    assistant_usage = {
        "sampling_kind": "assistant",
        "input_tokens": 100,
        "cached_input_tokens": 40,
        "cache_hit_rate": 0.4,
        "output_tokens": 25,
        "total_tokens": 125,
        "context_usage_percent": 0.1,
        "context_window_tokens": 1000,
        "anchor": {
            "local_estimated_input_tokens": 130,
            "local_estimated_chars": 520,
            "context_message_count": 3,
            "compact_generation": 1,
        },
    }
    compact_usage = {
        "sampling_kind": "compact",
        "input_tokens": 30,
        "cached_input_tokens": 0,
        "cache_hit_rate": 0,
        "output_tokens": 10,
        "total_tokens": 40,
        "context_usage_percent": 0.03,
        "context_window_tokens": 1000,
    }

    await store.persist_sampling_usage(assistant_usage)
    await store.persist_sampling_usage(compact_usage)

    latest = await store.get_latest_sampling_usage()
    latest_assistant = await store.get_latest_assistant_sampling_usage()

    assert latest["sampling_kind"] == "compact"
    assert latest["input_tokens"] == 30
    assert latest_assistant["sampling_kind"] == "assistant"
    assert latest_assistant["input_tokens"] == 100


@pytest.mark.asyncio
async def test_update_model_persists_session_meta(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, model="old-model", system_prompt="sys")
    await store.initialize()

    await store.update_model("new-model")

    session_base = Path(temp_session_dir) / store.session_id
    meta = json.loads((session_base / "meta.json").read_text(encoding="utf-8"))
    assert store.model == "new-model"
    assert meta["model"] == "new-model"


@pytest.mark.asyncio
async def test_resume_repairs_stale_meta_counts(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "hello")
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "call_1", "name": "bash"}]})
    await store.persist_tool_call(
        call_id="call_1",
        name="bash",
        parsed_args={"command": "date"},
        raw_args='{"command":"date"}',
        ts_start=store.now_iso(),
        ts_end=store.now_iso(),
        result_payload=json.dumps({"ok": True, "tool": "bash", "data": "raw result"}),
        model_content="fixed model content",
    )

    session_base = Path(temp_session_dir) / store.session_id
    meta_path = session_base / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["message_count"] = 0
    meta["tool_call_count"] = 0
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id=store.session_id)
    await resumed.initialize()

    repaired = json.loads(meta_path.read_text(encoding="utf-8"))
    assert repaired["message_count"] == 3
    assert repaired["tool_call_count"] == 1


@pytest.mark.asyncio
async def test_resume_repairs_invalid_meta_counts(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()
    await store.persist_message("user", "hello")

    session_base = Path(temp_session_dir) / store.session_id
    meta_path = session_base / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["message_count"] = "bad"
    meta["tool_call_count"] = "also bad"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id=store.session_id)
    await resumed.initialize()

    repaired = json.loads(meta_path.read_text(encoding="utf-8"))
    assert repaired["message_count"] == 2
    assert repaired["tool_call_count"] == 0


@pytest.mark.asyncio
async def test_resume_normalizes_auto_compact_window_meta(temp_session_dir):
    store = JsonlSessionStore(session_dir=temp_session_dir, system_prompt="sys")
    await store.initialize()

    session_base = Path(temp_session_dir) / store.session_id
    meta_path = session_base / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["auto_compact_window"] = {"ordinal": "bad"}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    resumed = JsonlSessionStore(session_dir=temp_session_dir, session_id=store.session_id)
    await resumed.initialize()

    repaired = json.loads(meta_path.read_text(encoding="utf-8"))
    assert repaired["auto_compact_window"] == {"ordinal": 1}


def main() -> int:
    async def _run_all():
        with tempfile.TemporaryDirectory() as tmp:
            await test_async_session_store_facade(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_persist_tool_call_writes_model_content(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_message_projector_deduplicates_tool_messages(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_get_messages_slice_recovers_missing_tool_message_from_record(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_get_messages_slice_matches_numeric_tool_ids_as_strings(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_get_messages_slice_uses_projection_cache_until_files_change(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_get_messages_slice_rejects_tool_record_without_model_content(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_persist_tool_call_requires_model_content(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_legacy_session_schema_is_rejected(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_persist_compaction_appends_boundary_without_rewriting_messages(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_persist_compaction_projects_minimal_replacement_boundary(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_orphan_compaction_record_does_not_compact_context(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_unmatched_compact_boundary_does_not_truncate_context(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_invalid_compaction_record_does_not_truncate_context(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_latest_valid_compact_boundary_survives_newer_broken_boundary(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_sampling_usage_and_compact_generation_meta(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_sampling_usage_keeps_latest_assistant_usage_when_compact_usage_arrives(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_update_model_persists_session_meta(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_resume_repairs_stale_meta_counts(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_resume_repairs_invalid_meta_counts(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            await test_resume_normalizes_auto_compact_window_meta(tmp)
        with tempfile.TemporaryDirectory() as tmp:
            test_session_files_read_jsonl_waits_for_active_writer(Path(tmp))
        with tempfile.TemporaryDirectory() as tmp:
            test_session_files_load_json_waits_for_active_writer(Path(tmp))
        with tempfile.TemporaryDirectory() as tmp:
            test_session_files_load_json_reports_corrupt_json(Path(tmp))
        with tempfile.TemporaryDirectory() as tmp:
            monkeypatch = pytest.MonkeyPatch()
            try:
                test_session_files_write_json_removes_tmp_on_replace_failure(monkeypatch, Path(tmp))
            finally:
                monkeypatch.undo()

    asyncio.run(_run_all())
    print("JsonlSessionStore tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
