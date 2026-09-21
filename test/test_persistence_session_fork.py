import asyncio
import hashlib
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence import JsonlSessionStore, fork_session
from agent.infrastructure.persistence.session_files import SessionFiles


@pytest.fixture
def temp_session_dir():
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)


def _seed_history(session_dir: str, session_id: str = "20260907_alpha") -> None:
    async def _run() -> None:
        store = JsonlSessionStore(
            session_dir=session_dir,
            session_id=session_id,
            system_prompt="sys",
            workspace_root=session_dir,
        )
        await store.initialize()
        await store.persist_message("user", "first question")
        await store.persist_message("assistant", "first answer")
        await store.persist_message("user", "second question")
        await store.persist_message("assistant", "second answer")

    asyncio.run(_run())


def _messages(session_dir: str, session_id: str) -> list[dict]:
    base = Path(session_dir) / session_id
    return SessionFiles().read_jsonl(str(base / "messages.jsonl"))


def _user_message_id(session_dir: str, session_id: str, content: str) -> str:
    matches = [m for m in _messages(session_dir, session_id) if m.get("content") == content]
    assert matches, f"message not found: {content}"
    return str(matches[0]["id"])


def _source_hashes(session_dir: str, session_id: str) -> dict:
    base = Path(session_dir) / session_id
    return {
        str(path.relative_to(base)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(base.rglob("*"))
        if path.is_file() and not path.name.endswith(".lock")
    }


def _index(session_dir: str) -> dict:
    return SessionFiles().load_json(str(Path(session_dir) / "index.json")) or {}


def test_fork_copies_full_snapshot_without_touching_source(temp_session_dir):
    _seed_history(temp_session_dir)
    before = _source_hashes(temp_session_dir, "20260907_alpha")

    new_id = fork_session(temp_session_dir, "20260907_alpha")

    assert new_id != "20260907_alpha"
    assert _messages(temp_session_dir, new_id) == _messages(temp_session_dir, "20260907_alpha")
    assert _source_hashes(temp_session_dir, "20260907_alpha") == before

    files = SessionFiles()
    meta = files.load_json(str(Path(temp_session_dir) / new_id / "meta.json"))
    assert meta["session_id"] == new_id
    assert meta["parent_session_id"] == "20260907_alpha"
    assert meta["title"].endswith(" (fork)")
    assert meta["message_count"] == len(_messages(temp_session_dir, new_id))

    entries = {entry["id"]: entry for entry in _index(temp_session_dir)["sessions"]}
    assert entries[new_id]["parent_session_id"] == "20260907_alpha"
    assert entries[new_id]["has_user_message"] is True
    assert entries[new_id]["title"] == meta["title"]


def test_fork_truncates_before_the_requested_user_message(temp_session_dir):
    _seed_history(temp_session_dir)
    before_id = _user_message_id(temp_session_dir, "20260907_alpha", "second question")

    new_id = fork_session(temp_session_dir, "20260907_alpha", before_message_id=before_id)

    retained = _messages(temp_session_dir, new_id)
    source = _messages(temp_session_dir, "20260907_alpha")
    assert retained == source[:3]
    meta = SessionFiles().load_json(str(Path(temp_session_dir) / new_id / "meta.json"))
    assert meta["message_count"] == 3
    entry = {e["id"]: e for e in _index(temp_session_dir)["sessions"]}[new_id]
    assert entry["size"]["messages"] == 3


def test_fork_keeps_only_compactions_entirely_before_the_cut(temp_session_dir):
    _seed_history(temp_session_dir)
    before_id = _user_message_id(temp_session_dir, "20260907_alpha", "second question")
    cut = 3
    compactions_path = Path(temp_session_dir) / "20260907_alpha" / "compactions.jsonl"
    files = SessionFiles()
    files.append_jsonl(
        str(compactions_path),
        {"id": "compact-early", "source": {"message_end_index_exclusive": 2}},
    )
    files.append_jsonl(
        str(compactions_path),
        {"id": "compact-late", "source": {"message_end_index_exclusive": cut}},
    )

    new_id = fork_session(temp_session_dir, "20260907_alpha", before_message_id=before_id)

    kept = SessionFiles().read_jsonl(str(Path(temp_session_dir) / new_id / "compactions.jsonl"))
    assert [record["id"] for record in kept] == ["compact-early"]
    meta = SessionFiles().load_json(str(Path(temp_session_dir) / new_id / "meta.json"))
    assert meta["latest_compaction"]["id"] == "compact-early"
    assert meta["auto_compact_window"] == {"ordinal": 2}

    end_fork = fork_session(temp_session_dir, "20260907_alpha")
    kept_all = SessionFiles().read_jsonl(str(Path(temp_session_dir) / end_fork / "compactions.jsonl"))
    assert [record["id"] for record in kept_all] == ["compact-early", "compact-late"]


def test_fork_rejects_invalid_points(temp_session_dir):
    _seed_history(temp_session_dir)
    assistant_id = next(
        str(m["id"]) for m in _messages(temp_session_dir, "20260907_alpha") if m.get("role") == "assistant"
    )

    with pytest.raises(ValueError, match="Fork message not found."):
        fork_session(temp_session_dir, "20260907_alpha", before_message_id="missing-id")
    with pytest.raises(ValueError, match="Fork point must be a user message."):
        fork_session(temp_session_dir, "20260907_alpha", before_message_id=assistant_id)
    with pytest.raises(LookupError):
        fork_session(temp_session_dir, "20990101_missing")


def test_fork_requires_a_user_message(temp_session_dir):
    async def _run() -> None:
        store = JsonlSessionStore(
            session_dir=temp_session_dir,
            session_id="20260907_empty",
            system_prompt="sys",
            workspace_root=temp_session_dir,
        )
        await store.initialize()

    asyncio.run(_run())

    with pytest.raises(ValueError, match="Nothing to fork"):
        fork_session(temp_session_dir, "20260907_empty")


def test_fork_title_suffix_is_idempotent(temp_session_dir):
    _seed_history(temp_session_dir)
    first = fork_session(temp_session_dir, "20260907_alpha")
    second = fork_session(temp_session_dir, first)

    files = SessionFiles()
    first_title = files.load_json(str(Path(temp_session_dir) / first / "meta.json"))["title"]
    second_title = files.load_json(str(Path(temp_session_dir) / second / "meta.json"))["title"]
    assert first_title == second_title
    assert first_title.count("(fork)") == 1


def test_fork_omits_unreferenced_tool_calls(temp_session_dir):
    _seed_history(temp_session_dir)
    tool_calls_path = Path(temp_session_dir) / "20260907_alpha" / "tool_calls.jsonl"
    SessionFiles().append_jsonl(
        str(tool_calls_path),
        {"id": "call-1", "name": "bash", "ok": True, "model_content": "done"},
    )

    new_id = fork_session(temp_session_dir, "20260907_alpha")

    copied = SessionFiles().read_jsonl(str(Path(temp_session_dir) / new_id / "tool_calls.jsonl"))
    assert copied == []


@pytest.mark.asyncio
async def test_image_fork_keeps_only_retained_references_and_survives_source_delete(tmp_path):
    from PIL import Image
    from agent.infrastructure.persistence.image_attachments import load_image
    source = tmp_path / "image.png"
    sessions = tmp_path / "sessions"
    store = JsonlSessionStore(session_dir=str(sessions), workspace_root=str(tmp_path))
    await store.initialize()
    await store.persist_user_input("first")
    Image.new("RGB", (4, 4), "red").save(source)
    early, _ = store.capture_image(str(source))
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "early", "name": "read_file", "raw_args": "{}"}]})
    await store.persist_tool_call("early", "read_file", {}, "{}", "start", "end", "read", model_content="read", attachments=[early])
    await store.persist_message("tool", "", tool_call_id="early", tool_name="read_file")
    await store.persist_user_input("second")
    cut_id = (await store.load_messages())[-1]["id"]
    Image.new("RGB", (4, 4), "blue").save(source)
    late, _ = store.capture_image(str(source))
    await store.persist_message("assistant", "", meta={"tool_calls": [{"id": "late", "name": "read_file", "raw_args": "{}"}]})
    await store.persist_tool_call("late", "read_file", {}, "{}", "start", "end", "read", model_content="read", attachments=[late])
    await store.persist_message("tool", "", tool_call_id="late", tool_name="read_file")
    new_id = fork_session(str(sessions), store.session_id, before_message_id=cut_id)
    fork = sessions / new_id
    copied = SessionFiles().read_jsonl(str(fork / "tool_calls.jsonl"))
    assert [r["id"] for r in copied] == ["early"]
    assert (fork / early["path"]).is_file() and not (fork / late["path"]).exists()
    shutil.rmtree(store.session_base_path)
    assert load_image(str(fork), early)
    from agent.runtime.server.session_service import SessionService
    await SessionService(session_dir=str(sessions), provider_service=None).delete(new_id)
    assert not fork.exists()


@pytest.mark.asyncio
async def test_failed_image_fork_leaves_no_directory_or_index_entry(tmp_path):
    from PIL import Image
    sessions = tmp_path / "sessions"
    source = tmp_path / "image.png"
    Image.new("RGB", (4, 4)).save(source)
    store = JsonlSessionStore(session_dir=str(sessions), workspace_root=str(tmp_path))
    await store.initialize()
    await store.persist_user_input("start")
    ref, _ = store.capture_image(str(source))
    await store.persist_message("user", "inspect", attachments=[ref])
    Path(store.session_base_path, ref["path"]).unlink()
    before = set(sessions.iterdir())
    index = _index(str(sessions))
    with pytest.raises(Exception, match="missing or damaged"):
        fork_session(str(sessions), store.session_id)
    assert set(sessions.iterdir()) == before and _index(str(sessions)) == index
