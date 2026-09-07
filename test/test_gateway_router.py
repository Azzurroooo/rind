import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway import InboundMessage
from gateway.router import SessionCreateError, SessionRouter, session_key


def _message(**overrides) -> InboundMessage:
    base = dict(
        channel="telegram",
        chat_id="123",
        chat_type="dm",
        sender_id="u1",
        sender_name="n",
        thread_id=None,
        text="hi",
        attachments=(),
        message_ref="m-1",
    )
    base.update(overrides)
    return InboundMessage(**base)


class _StubWorker:
    def __init__(self, session_id="s-1", fail=False):
        self.calls: list[tuple[str, dict]] = []
        self._session_id = session_id
        self._fail = fail

    async def request(self, method, params):
        self.calls.append((method, params))
        if self._fail:
            raise RuntimeError("worker down")
        return {"session_id": self._session_id}


def test_session_key_is_pure_and_thread_aware():
    assert session_key(_message()) == "telegram:dm:123"
    assert session_key(_message(chat_type="group", chat_id="g", thread_id="t9")) == "telegram:group:g:t9"
    # same inputs → same key, no state
    assert session_key(_message()) == session_key(_message())


def test_ensure_session_creates_with_workspace_and_persists(tmp_path):
    state_path = tmp_path / "state.json"
    router = SessionRouter(state_path)
    worker = _StubWorker(session_id="20260907_abcd")
    record = asyncio.run(router.ensure_session("telegram:dm:123", worker, "/ws"))

    assert record.session_id == "20260907_abcd"
    assert worker.calls == [("session/new", {"workspace_root": "/ws", "owner_agent_id": "gateway:telegram:dm:123"})]
    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["sessions"]["telegram:dm:123"] == {"session_id": "20260907_abcd", "cursor": 0}
    assert not list(tmp_path.glob("*.tmp"))


def test_ensure_session_reuses_mapping_without_new_call(tmp_path):
    router = SessionRouter(tmp_path / "state.json")
    worker = _StubWorker()
    asyncio.run(router.ensure_session("k", worker, "/ws"))
    again = asyncio.run(router.ensure_session("k", worker, "/ws"))
    assert again.session_id == "s-1"
    assert len(worker.calls) == 1


def test_ensure_session_retries_once_then_raises(tmp_path):
    router = SessionRouter(tmp_path / "state.json")
    worker = _StubWorker(fail=True)
    with pytest.raises(SessionCreateError):
        asyncio.run(router.ensure_session("k", worker, "/ws"))
    assert len(worker.calls) == 2  # exactly one retry


def test_update_cursor_is_monotonic_and_persisted(tmp_path):
    state_path = tmp_path / "state.json"
    router = SessionRouter(state_path)
    asyncio.run(router.ensure_session("k", _StubWorker(), "/ws"))

    assert router.update_cursor("k", 5) is True
    assert router.update_cursor("k", 5) is False  # no regression, no rewrite
    assert router.update_cursor("k", 3) is False
    assert router.cursor_for("k") == 5

    reloaded = SessionRouter(state_path)
    assert reloaded.cursor_for("k") == 5
    assert reloaded.key_for_session("s-1") == "k"


def test_corrupt_state_is_renamed_and_routing_starts_empty(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text("{not valid json", encoding="utf-8")

    router = SessionRouter(state_path)

    assert router.all_sessions() == {}
    assert (tmp_path / "state.json.corrupt").is_file()
    assert not state_path.exists() or state_path.read_text(encoding="utf-8") == ""
