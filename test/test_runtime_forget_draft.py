import asyncio
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.runtime.server.dispatcher import RuntimeDispatcher
from agent.runtime.server.protocol import RuntimeMethod
from agent.runtime.server.session_service import SessionService


class _Providers:
    def default_selection(self, root):
        from agent.domain.models import ModelSelection

        return ModelSelection(provider_id="openai-compatible", model_id="fixture", reasoning_effort=None)


def test_only_an_unsaved_draft_is_forgotten(tmp_path):
    async def scenario():
        sessions = SessionService(session_dir=str(tmp_path / "sessions"), provider_service=_Providers())
        draft = await sessions.create(str(tmp_path), defer_persistence=True)
        saved = await sessions.create(str(tmp_path))
        assert sessions.draft_store(draft["session_id"]) is not None
        assert sessions.forget_draft(saved["session_id"]) is False, "a saved conversation is never forgotten"
        assert (await sessions.metadata(saved["session_id"]))["session_id"] == saved["session_id"]
        assert sessions.forget_draft(draft["session_id"]) is True
        assert sessions.draft_store(draft["session_id"]) is None
        assert sessions.forget_draft(draft["session_id"]) is False, "forgetting twice is harmless"
        assert not (tmp_path / "sessions" / draft["session_id"]).exists(), "nothing was ever written for it"

    asyncio.run(scenario())


class _Execution:
    def __init__(self, active=()):
        self._active = set(active)

    def add_event_sink(self, sink):
        return lambda: None

    def active_session_ids(self):
        return set(self._active)


class _Worker:
    def __init__(self, active=()):
        self.session_id = "20261007_000000_aaaaaaaa"
        self.execution = _Execution(active)
        self.forgotten = []

    async def forget_draft(self, session_id):
        self.forgotten.append(session_id)
        return True


class _Writer:
    def __init__(self):
        self.payloads = []

    async def send(self, payload):
        self.payloads.append(payload)


def _dispatch(worker, session_id):
    writer = _Writer()
    server = RuntimeDispatcher(worker, writer=writer)
    server._initialized = True
    request = {"kind": "request", "request_id": "f-1", "method": RuntimeMethod.RIND_SESSION_FORGET_DRAFT, "params": {"session_id": session_id}}
    asyncio.run(server.dispatch(request))
    return writer.payloads[-1]


def test_forget_draft_is_routed_and_skips_a_running_conversation():
    idle = _Worker()
    response = _dispatch(idle, "20261007_000000_bbbbbbbb")
    assert response.get("result") == {"forgotten": True}
    assert idle.forgotten == ["20261007_000000_bbbbbbbb"]

    busy = _Worker(active={"20261007_000000_bbbbbbbb"})
    response = _dispatch(busy, "20261007_000000_bbbbbbbb")
    assert response.get("result") == {"forgotten": False}
    assert busy.forgotten == []
