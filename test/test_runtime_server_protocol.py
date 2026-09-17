import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from helpers.fake_worker import FakeContainer, FakeRuntime, FakeStore, FakeWorker, make_server

from agent.version import __version__

from agent.runtime.core import InputQueueError
from agent.runtime.server.stdio import (
    JsonlWriter,
    WorkerStdioRuntimeServer,
    _schedule_ingest,
    configure_stdio_server_signals,
    configure_utf8_stdio,
)
from agent.runtime.server.commands import SlashCommandInfo, SlashCommandRouter
from agent.runtime.server.protocol import (
    CAPABILITIES,
    CORE_METHODS,
    DURABLE_EVENT_TYPES,
    RuntimeMethod,
    event_envelope,
    validate_request,
)
from agent.runtime.server.replay_events import project_durable_events


def _messages(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def _response(payloads, request_id):
    return next(message for message in payloads if message.get("request_id") == request_id)


# -- wire envelope --------------------------------------------------------------


def test_jsonl_writer_uses_compact_json(capsys):
    async def run():
        await JsonlWriter().send({"kind": "event", "event": {"type": "turn_completed"}})

    asyncio.run(run())
    assert capsys.readouterr().out == '{"kind":"event","event":{"type":"turn_completed"}}\n'


def test_runtime_events_use_versioned_envelope():
    worker = FakeWorker()
    server, payloads = make_server(worker)
    server._subscribed.add("s1")

    async def run():
        await server._send_event({"type": "assistant_delta", "session_id": "s1", "turn_id": "t1", "text": "hello"})
        await server._send_event({"type": "turn_completed", "session_id": "s1", "turn_id": "t1"})

    asyncio.run(run())

    assert [message["sequence"] for message in payloads] == [1, 2]
    assert payloads[0]["method"] == RuntimeMethod.SESSION_UPDATE
    assert payloads[0]["durability"] == "incremental"
    assert payloads[0]["session_id"] == "s1"
    assert payloads[0]["turn_id"] == "t1"
    assert payloads[0]["event"]["text"] == "hello"


def test_events_for_unsubscribed_sessions_are_dropped():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._send_event({"type": "assistant_delta", "session_id": "s1", "turn_id": "t1", "text": "hello"})

    asyncio.run(run())
    assert payloads == []


def test_golden_event_fixture_matches_python_envelope():
    fixture = PROJECT_ROOT / "test" / "fixtures" / "runtime_protocol.golden.jsonl"
    messages = [json.loads(line) for line in fixture.read_text(encoding="utf-8").splitlines()]
    events = [message for message in messages if message["kind"] == "event"]
    responses = [message for message in messages if message["kind"] == "response"]
    requests = [message for message in messages if message["kind"] == "request"]

    assert [event_envelope(message["event"], message["sequence"]) for message in events] == events
    assert [message["sequence"] for message in events] == [1, 2, 3, 4, 5]
    assert [validate_request(request) for request in requests] == [None] * len(requests)
    assert [request["method"] for request in requests] == [
        "file/list",
        "file/read",
        "file/write",
        "session/subscribe",
        "session/unsubscribe",
        "session/delete",
        "session/fork",
        "ping",
        "rind/context/inspect",
        "rind/usage/summary",
    ]
    assert [(response["request_id"], "error" in response) for response in responses] == [
        ("turn-1", False),
        ("interrupt-2", True),
        ("file-list-1", False),
        ("file-read-1", False),
        ("file-write-1", False),
        ("subscribe-1", False),
        ("unsubscribe-1", False),
        ("delete-1", False),
        ("fork-1", False),
        ("ping-1", False),
        ("context-inspect-1", False),
        ("usage-summary-1", False),
    ]


def test_event_envelope_separates_durable_and_incremental_events():
    assert event_envelope({"type": "assistant_delta"}, 1)["durability"] == "incremental"
    assert event_envelope({"type": "tool_input_delta"}, 2)["durability"] == "incremental"
    assert event_envelope({"type": "queued_input_delivered"}, 3)["durability"] == "incremental"
    assert event_envelope({"type": "tool_result"}, 2)["durability"] == "durable"


def test_request_validation_requires_the_standard_envelope() -> None:
    assert validate_request({"kind": "request", "request_id": 1, "method": "initialize"}) is None
    assert validate_request({"request_id": 1, "method": "initialize"}) == 'kind must be "request".'
    assert validate_request({"kind": "request", "request_id": None, "method": "initialize"}) == "request_id is required."
    assert validate_request({"kind": "request", "request_id": 1, "method": "", "params": {}}) == "method is required."
    assert validate_request({"kind": "request", "request_id": 1, "method": "initialize", "params": []}) == "params must be an object."


# -- initialize ----------------------------------------------------------------


def test_initialize_response_includes_resume_preview_and_catalog():
    worker = FakeWorker()
    worker.messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    worker.providers = [{"id": "openai", "name": "OpenAI", "methods": ["api_key"], "configured": False, "source": "none"}]
    server, payloads = make_server(worker)
    server._initialized = False

    async def run():
        await server._dispatch({"kind": "request", "request_id": 7, "method": "initialize", "params": {}})

    asyncio.run(run())

    result = _response(payloads, 7)["result"]
    assert result["protocol_version"] == "2"
    assert result["version"] == __version__
    assert result["capabilities"] == [*CAPABILITIES, "rind/goals"]
    assert result["methods"] == [
        *CORE_METHODS,
        RuntimeMethod.RIND_GOAL_GET,
        RuntimeMethod.RIND_GOAL_SET,
        RuntimeMethod.RIND_GOAL_STATUS,
        RuntimeMethod.RIND_GOAL_CLEAR,
    ]
    assert result["session_id"] == "s1"
    assert result["model"] == "m1"
    assert result["provider"] == "p1"
    assert result["providers"] == worker.providers
    assert "user: hello" in result["resume_preview"]
    assert any(command["name"] == "status" for command in result["commands"])


@pytest.mark.parametrize("identity", [None, {"agent_id": "lead", "project_name": "Team"}])
def test_initialize_forwards_team_display_identity(identity):
    worker = FakeWorker()
    initialize = worker.initialize

    async def initialize_with_team():
        return {**await initialize(), "team_main": identity}

    worker.initialize = initialize_with_team
    server, payloads = make_server(worker)
    server._initialized = False
    asyncio.run(server._dispatch({"kind": "request", "request_id": "team-init", "method": "initialize", "params": {}}))
    assert _response(payloads, "team-init")["result"]["team_main"] == identity


def test_methods_before_initialize_are_rejected():
    worker = FakeWorker()
    server, payloads = make_server(worker)
    server._initialized = False

    async def run():
        await server._dispatch({"kind": "request", "request_id": 1, "method": "session/list", "params": {}})

    asyncio.run(run())
    assert _response(payloads, 1)["error"]["type"] == "ServerNotReady"


# -- turns ---------------------------------------------------------------------


def test_turn_response_contains_session_and_turn_ids():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 21, "method": "session/prompt", "params": {"session_id": "s1", "input": "hello"}}
        )

    asyncio.run(run())

    events = [message for message in payloads if message.get("kind") == "event"]
    assert [message["event"]["type"] for message in events] == ["turn_started", "turn_completed"]
    assert _response(payloads, 21)["result"] == {"ok": True, "session_id": "s1", "turn_id": "t1"}


def test_turn_prompt_preserves_input_text_and_resume_flag():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {
                "kind": "request",
                "request_id": 23,
                "method": "session/prompt",
                "params": {"session_id": "s1", "input": "  preserve surrounding text  "},
            }
        )
        await server._dispatch(
            {"kind": "request", "request_id": 24, "method": "session/prompt", "params": {"session_id": "s1", "resume": True}}
        )

    asyncio.run(run())

    assert worker.execution.queries[0]["query"] == "  preserve surrounding text  "
    assert worker.execution.queries[1]["resume"] is True
    assert worker.execution.queries[1]["query"] == ""
    assert _response(payloads, 24)["result"]["ok"] is True


def test_turn_requires_input_or_resume():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 25, "method": "session/prompt", "params": {"session_id": "s1"}})

    asyncio.run(run())
    assert _response(payloads, 25)["error"]["type"] == "InvalidRequest"


def test_serve_answers_slash_commands_while_a_turn_occupies_the_runtime():
    async def run():
        worker = FakeWorker()
        worker.execution.blocking = True
        server, payloads = make_server(worker)
        serve = asyncio.create_task(server._serve())
        server._requests.put_nowait(
            {"kind": "request", "request_id": 41, "method": "session/prompt", "params": {"session_id": "s1", "input": "hello"}}
        )
        await worker.execution.started.wait()
        server._requests.put_nowait(
            {"kind": "request", "request_id": 42, "method": "rind/command/execute", "params": {"session_id": "s1", "input": "/status"}}
        )
        await _await_response(payloads, 42)
        worker.execution.release.set()
        await _await_response(payloads, 41)
        server._begin_shutdown()
        return await asyncio.wait_for(serve, 10)

    assert asyncio.run(run()) == 0


def test_slash_commands_reuse_the_cli_router():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 8, "method": "rind/command/execute", "params": {"session_id": "s1", "input": "/help"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 9, "method": "rind/command/execute", "params": {"session_id": "s1", "input": "/status bad"}}
        )

    asyncio.run(run())

    assert _response(payloads, 8)["result"]["display"]["type"] == "help"
    assert _response(payloads, 9)["result"]["text"] == "Usage: /status"


def test_compact_request_returns_turn_active_error_while_a_turn_is_active():
    worker = FakeWorker()
    worker.containers["s1"] = FakeContainer(FakeStore(worker, "s1"), FakeRuntime(turn_active=True))
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 50, "method": "rind/session/compact", "params": {"session_id": "s1"}}
        )

    asyncio.run(run())
    assert _response(payloads, 50)["error"] == {
        "type": "TurnActive",
        "message": "Cannot compact context while a turn is active.",
    }


async def _await_response(payloads: list, request_id, timeout: float = 10.0) -> None:
    async def poll() -> None:
        while not any(message.get("request_id") == request_id for message in payloads):
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


# -- queued turn inputs ----------------------------------------------------------


def test_turn_input_controls_reach_execution():
    worker = FakeWorker()
    worker.execution.active_turn_ids["s1"] = "t1"
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 31, "method": "rind/session/steer", "params": {"session_id": "s1", "turn_id": "t1", "input": "change direction"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 32, "method": "rind/session/follow_up", "params": {"session_id": "s1", "turn_id": "t1", "input": "next task"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 33, "method": "rind/session/unsteer", "params": {"session_id": "s1", "turn_id": "t1"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 34, "method": "rind/session/promote_follow_up", "params": {"session_id": "s1", "turn_id": "t1", "input_id": "follow-1"}}
        )

    asyncio.run(run())

    assert worker.execution.submitted == [
        ("submit", "steering", "change direction"),
        ("submit", "follow_up", "next task"),
        ("retrieve", "steering", None),
        ("promote", "follow_up", "follow-1"),
    ]
    assert _response(payloads, 31)["result"]["mode"] == "steering"
    assert _response(payloads, 32)["result"]["mode"] == "follow_up"
    assert _response(payloads, 33)["result"]["retrieved"] is True
    assert _response(payloads, 34)["result"]["mode"] == "steering"


def test_turn_input_control_rejection_is_structured_protocol_error():
    worker = FakeWorker()
    worker.execution.active_turn_ids["s1"] = "t1"
    worker.execution.input_queue_error = InputQueueError("steering queue is full", "InputQueueFull")
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 33, "method": "rind/session/steer", "params": {"session_id": "s1", "turn_id": "t1", "input": "change"}}
        )

    asyncio.run(run())
    assert _response(payloads, 33)["error"] == {"type": "InputQueueFull", "message": "steering queue is full"}


def test_turn_scoped_controls_require_the_active_turn_id():
    worker = FakeWorker()
    worker.execution.active_turn_ids["s1"] = "t1"
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 34, "method": "rind/session/steer", "params": {"session_id": "s1", "turn_id": "stale", "input": "change"}}
        )

    asyncio.run(run())
    assert _response(payloads, 34)["error"]["type"] == "TurnNotActive"
    assert worker.execution.submitted == []


def test_readonly_session_replay_is_handled_while_run_turn_is_blocked():
    async def run():
        worker = FakeWorker()
        worker.execution.blocking = True
        server, payloads = make_server(worker)
        turn_task = asyncio.create_task(
            server._dispatch(
                {"kind": "request", "request_id": 37, "method": "session/prompt", "params": {"session_id": "s1", "input": "hello"}}
            )
        )
        await worker.execution.started.wait()
        await server._dispatch(
            {"kind": "request", "request_id": 38, "method": "session/replay", "params": {"session_id": "s1"}}
        )
        assert not turn_task.done()
        worker.execution.release.set()
        await turn_task
        return payloads

    payloads = asyncio.run(run())
    replay = _response(payloads, 38)
    assert replay["result"]["messages"] == []
    assert replay["result"]["session_id"] == "s1"


# -- user questions ----------------------------------------------------------------


def test_user_question_responses_reach_execution():
    worker = FakeWorker()
    worker.pending_questions["call-1"] = ""
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {
                "kind": "request",
                "request_id": 61,
                "method": "rind/user-question/respond",
                "params": {"session_id": "s1", "tool_call_id": "call-1", "answer": "yes"},
            }
        )
        await server._dispatch(
            {
                "kind": "request",
                "request_id": 62,
                "method": "rind/user-question/respond",
                "params": {"session_id": "s1", "tool_call_id": "missing", "answer": "no"},
            }
        )

    asyncio.run(run())

    assert worker.pending_questions["call-1"] == "yes"
    assert _response(payloads, 61)["result"] == {"ok": True}
    assert _response(payloads, 62)["error"]["type"] == "QuestionNotFound"


# -- sessions ----------------------------------------------------------------


def test_session_list_returns_recent_sessions_and_current_id():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 27, "method": "session/list", "params": {"limit": 3}})

    asyncio.run(run())

    result = _response(payloads, 27)["result"]
    assert result["current_session_id"] == "s1"
    assert result["sessions"] == [{"id": "s1", "title": "session s1"}]


def test_session_new_returns_created_metadata():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 28, "method": "session/new", "params": {}})

    asyncio.run(run())
    assert _response(payloads, 28)["result"]["session_id"] == "new-session"


def test_unknown_sessions_surface_as_session_not_found():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 29, "method": "session/switch", "params": {"session_id": "archived"}})

    asyncio.run(run())
    assert _response(payloads, 29)["error"]["type"] == "SessionNotFound"


# -- goals --------------------------------------------------------------------


def test_goal_control_requests_update_and_clear_state():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 10, "method": "rind/goal/set", "params": {"session_id": "s1", "objective": "ship it"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 11, "method": "rind/goal/status", "params": {"session_id": "s1", "status": "paused"}}
        )
        await server._dispatch(
            {"kind": "request", "request_id": 12, "method": "rind/goal/clear", "params": {"session_id": "s1"}}
        )

    asyncio.run(run())

    assert _response(payloads, 10)["result"]["goal"] == {"objective": "ship it", "status": "active"}
    assert _response(payloads, 11)["result"]["goal"]["status"] == "paused"
    assert _response(payloads, 12)["result"]["goal"] is None


# -- background ----------------------------------------------------------------


def test_background_requests_use_control_callbacks(capsys):
    async def list_backgrounds(session_id):
        assert session_id == "s1"
        return [{"bg_id": "bg_1", "status": "running"}]

    async def snapshot_background(bg_id, *, max_output_chars, _session_id):
        assert (bg_id, max_output_chars, _session_id) == ("bg_1", 100, "s1")
        return {"bg_id": bg_id, "status": "running", "stdout": "tick"}

    worker = FakeWorker()
    server, payloads = make_server(worker)
    server._background_list = list_backgrounds
    server._background_output = snapshot_background

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 30, "method": "rind/background/list", "params": {"session_id": "s1"}}
        )
        await server._dispatch(
            {
                "kind": "request",
                "request_id": 31,
                "method": "rind/background/output",
                "params": {"session_id": "s1", "bg_id": "bg_1", "max_output_chars": 100},
            }
        )
        await server._dispatch(
            {"kind": "request", "request_id": 32, "method": "rind/background/output", "params": {"session_id": "s1", "bg_id": ""}}
        )

    asyncio.run(run())

    assert _response(payloads, 30)["result"] == {"tasks": [{"bg_id": "bg_1", "status": "running"}]}
    assert _response(payloads, 31)["result"]["task"]["stdout"] == "tick"
    assert _response(payloads, 32)["error"]["type"] == "InvalidRequest"


# -- models and auth -------------------------------------------------------------


def test_model_list_returns_structured_models_current_and_warning():
    worker = FakeWorker()
    worker.models_listing = {
        "models": [{"provider_id": "openai", "id": "gpt-5.5", "name": "GPT-5.5", "api": "openai-responses", "reasoning_efforts": ["low", "high"], "context_window": None}],
        "warning": "failed to refresh OpenAI models, showing saved models",
    }
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 9, "method": "model/list", "params": {"session_id": "s1"}})

    asyncio.run(run())

    result = _response(payloads, 9)["result"]
    assert result["models"] == worker.models_listing["models"]
    assert result["current"] == {"provider_id": "p1", "model_id": "m1"}
    assert result["warning"] == "failed to refresh OpenAI models, showing saved models"


def test_model_set_updates_provider_and_model_atomically():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 12, "method": "model/set", "params": {"session_id": "s1", "provider_id": "deepseek", "model_id": "deepseek-chat"}}
        )

    asyncio.run(run())

    store = worker.stores["s1"]
    assert store.updates == [("deepseek", "deepseek-chat")]
    assert _response(payloads, 12)["result"]["model_id"] == "deepseek-chat"


def test_auth_login_adopts_provider_default_when_session_model_unusable():
    worker = FakeWorker()
    worker.models_listing = {
        "models": [
            {"provider_id": "deepseek", "id": "deepseek-chat", "name": "DeepSeek Chat", "api": "openai-chat", "reasoning_efforts": [], "context_window": None},
            {"provider_id": "deepseek", "id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "api": "openai-chat", "reasoning_efforts": [], "context_window": None},
        ],
        "warning": None,
    }
    server, payloads = make_server(worker)
    server._initialized = True

    async def run():
        login_task = asyncio.create_task(
            server._dispatch(
                {"kind": "request", "request_id": 71, "method": "rind/auth/login", "params": {"session_id": "s1", "provider_id": "deepseek", "method": "api_key"}}
            )
        )
        while not server._auth_waiters:
            await asyncio.sleep(0.01)
        (prompt_request_id, _future) = next(iter(server._auth_waiters.items()))
        prompt = next(message for message in payloads if message.get("request_id") == prompt_request_id)
        assert prompt["method"] == RuntimeMethod.RIND_AUTH_PROMPT
        assert prompt["params"]["kind"] == "secret"
        await server._dispatch(
            {"kind": "request", "request_id": prompt_request_id, "method": RuntimeMethod.RIND_AUTH_PROMPT, "params": {"value": "secret-key"}}
        )
        return await login_task

    asyncio.run(run())

    assert worker.login_prompt == "secret-key"
    result = _response(payloads, 71)["result"]
    assert result["ok"] is True
    assert result["provider_id"] == "deepseek"
    assert result["selection"] == {"provider_id": "deepseek", "model_id": "deepseek-chat"}
    assert worker.stores["s1"].updates == [("deepseek", "deepseek-chat")]


def test_auth_logout_reports_deletion_and_remaining_source():
    worker = FakeWorker()
    worker.providers = [{"id": "deepseek", "configured": True, "source": "environment"}]
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch(
            {"kind": "request", "request_id": 72, "method": "rind/auth/logout", "params": {"session_id": "s1", "provider_id": "deepseek"}}
        )

    asyncio.run(run())
    assert _response(payloads, 72)["result"] == {
        "ok": True,
        "provider_id": "deepseek",
        "deleted": True,
        "source": "environment",
    }


def test_auth_methods_require_provider_id():
    worker = FakeWorker()
    server, payloads = make_server(worker)

    async def run():
        await server._dispatch({"kind": "request", "request_id": 73, "method": "rind/auth/login", "params": {"session_id": "s1"}})
        await server._dispatch({"kind": "request", "request_id": 74, "method": "rind/auth/logout", "params": {"session_id": "s1"}})

    asyncio.run(run())
    assert _response(payloads, 73)["error"]["type"] == "InvalidRequest"
    assert _response(payloads, 74)["error"]["type"] == "InvalidRequest"


# -- shutdown ------------------------------------------------------------------


def test_shutdown_cancels_inflight_dispatch_and_exits_promptly():
    async def run():
        worker = FakeWorker()
        worker.execution.blocking = True
        server, payloads = make_server(worker)
        serve = asyncio.create_task(server._serve())
        server._requests.put_nowait(
            {"kind": "request", "request_id": 51, "method": "session/prompt", "params": {"session_id": "s1", "input": "hello"}}
        )
        await worker.execution.started.wait()
        server._begin_shutdown({"kind": "request", "request_id": "bye", "method": "shutdown", "params": {}})
        return await asyncio.wait_for(serve, 10), payloads

    exit_code, payloads = asyncio.run(run())
    assert exit_code == 0
    assert any(
        message.get("request_id") == "bye" and message.get("result") == {"ok": True}
        for message in payloads
    )


# -- durable replay ------------------------------------------------------------


def _append_completed_turn(worker: FakeWorker, turn_id: str, text: str) -> None:
    worker.messages.extend(
        [
            {"id": f"user-{turn_id}", "role": "user", "content": f"query {turn_id}"},
            {
                "id": f"assistant-{turn_id}",
                "role": "assistant",
                "content": text,
                "tool_calls": [
                    {
                        "id": f"call-{turn_id}",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path": "note.txt"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": f"call-{turn_id}", "content": "record body"},
        ]
    )
    worker.tool_records.append(
        {
            "id": f"call-{turn_id}",
            "name": "read_file",
            "raw_args": '{"path": "note.txt"}',
            "model_content": "record body",
            "ok": True,
            "ts_start": "2026-01-01T00:00:00+00:00",
            "ts_end": "2026-01-01T00:00:01.500000+00:00",
        }
    )
    worker.turn_state = {"turn_id": turn_id, "status": "completed", "ts": "2026-01-01T00:00:02+00:00"}


def test_replay_after_cursor_zero_returns_full_durable_stream():
    worker = FakeWorker()
    for index in range(3):
        _append_completed_turn(worker, f"t{index}", f"reply {index}")
    server, payloads = make_server(worker)

    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-0",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": 0},
            }
        )
    )

    result = _response(payloads, "replay-0")["result"]
    assert result["cursor"] == 13
    events = result["events"]
    assert [envelope["sequence"] for envelope in events] == list(range(1, 14))
    assert [envelope["event"]["type"] for envelope in events] == [
        "turn_started",
        "tool_requested",
        "assistant_message_completed",
        "tool_result",
    ] * 3 + ["turn_completed"]
    assert all(envelope["durability"] == "durable" for envelope in events)
    assert all(envelope["session_id"] == "s1" for envelope in events)
    assert events[1]["event"]["tool_call_id"] == "call-t0"
    assert events[1]["event"]["arguments"] == {"path": "note.txt"}
    assert events[1]["event"]["tool_name"] == "read_file"
    assert events[3]["event"]["result"] == "record body"
    assert events[3]["event"]["status"] == "completed"
    assert events[3]["event"]["duration_ms"] == 1500


def test_replay_after_cursor_returns_only_new_events():
    worker = FakeWorker()
    _append_completed_turn(worker, "t0", "first reply")
    server, payloads = make_server(worker)
    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-old",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": 0},
            }
        )
    )
    assert _response(payloads, "replay-old")["result"]["cursor"] == 5

    _append_completed_turn(worker, "t1", "second reply")
    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-new",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": 5},
            }
        )
    )

    result = _response(payloads, "replay-new")["result"]
    assert result["cursor"] == 9
    # Envelope sequences are the events' durable ordinals: stable across calls,
    # independent of any connection's send counter.
    assert [envelope["sequence"] for envelope in result["events"]] == [6, 7, 8, 9]
    tool_call_ids = [envelope["event"].get("tool_call_id") for envelope in result["events"]]
    assert "call-t1" in tool_call_ids
    assert "call-t0" not in tool_call_ids
    texts = [envelope["event"].get("text") for envelope in result["events"]]
    assert "second reply" in texts
    assert "first reply" not in texts


def test_replay_after_cursor_beyond_total_returns_empty_events():
    worker = FakeWorker()
    _append_completed_turn(worker, "t0", "only reply")
    server, payloads = make_server(worker)

    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-far",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": 99},
            }
        )
    )

    assert _response(payloads, "replay-far")["result"] == {"events": [], "cursor": 5}


@pytest.mark.parametrize(("cursor_value",), [(-1,), (True,), ("3",)])
def test_replay_after_cursor_rejects_invalid_values(cursor_value):
    worker = FakeWorker()
    _append_completed_turn(worker, "t0", "only reply")
    server, payloads = make_server(worker)

    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-bad",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": cursor_value},
            }
        )
    )

    assert _response(payloads, "replay-bad")["error"]["type"] == "InvalidRequest"


def test_replay_projection_emits_only_durable_event_types():
    worker = FakeWorker()
    worker.messages = [
        {"role": "user", "content": "checkpoint", "meta": {"kind": "goal_checkpoint"}},
        {"role": "user", "content": "boundary", "meta": {"kind": "compact_boundary"}},
        {"id": "u1", "role": "user", "content": "hello"},
        {"id": "a1", "role": "assistant", "content": "hi there"},
    ]
    worker.turn_state = {"turn_id": "t1", "status": "completed"}
    server, payloads = make_server(worker)

    asyncio.run(
        server._dispatch(
            {
                "kind": "request",
                "request_id": "replay-durable",
                "method": RuntimeMethod.SESSION_REPLAY,
                "params": {"session_id": "s1", "after_cursor": 0},
            }
        )
    )

    events = _response(payloads, "replay-durable")["result"]["events"]
    assert [envelope["event"]["type"] for envelope in events] == [
        "turn_started",
        "assistant_message_completed",
        "turn_completed",
    ]
    assert all(envelope["durability"] == "durable" for envelope in events)
    assert all(envelope["event"]["type"] in DURABLE_EVENT_TYPES for envelope in events)


def test_project_durable_events_maps_raw_meta_shapes_and_failures():
    events = project_durable_events(
        [
            {"role": "user", "content": "go", "meta": {"turn_id": "turn-9"}},
            {
                "role": "assistant",
                "content": "calling",
                "meta": {"turn_id": "turn-9", "tool_calls": [{"id": "call-1", "name": "bash", "raw_args": "not-json"}]},
            },
            {"role": "tool", "tool_call_id": "call-1", "content": ""},
        ],
        [{"id": "call-1", "name": "bash", "ok": False, "error_type": "BashError", "model_content": "boom"}],
        {"turn_id": "turn-9", "status": "failed", "error": "model exploded"},
        "s1",
    )

    assert events[0] == {"type": "turn_started", "session_id": "s1", "turn_id": "turn-9", "user_message_chars": 2}
    assert events[1] == {
        "type": "tool_requested",
        "session_id": "s1",
        "turn_id": "turn-9",
        "tool_call_id": "call-1",
        "tool_name": "bash",
        "arguments": {},
    }
    assert events[2] == {
        "type": "assistant_message_completed",
        "session_id": "s1",
        "turn_id": "turn-9",
        "content": "calling",
        "content_chars": len("calling"),
        "text": "calling",
    }
    assert events[3]["status"] == "error"
    assert events[3]["result"] == "boom"
    assert "duration_ms" not in events[3]
    assert events[4] == {
        "type": "turn_failed",
        "session_id": "s1",
        "turn_id": "turn-9",
        "reason": "model exploded",
    }


# -- process and stdio plumbing ----------------------------------------------------


def test_app_server_process_serves_git_backed_commands_and_exits_after_shutdown(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (home / ".rind").mkdir(parents=True)
    workspace.mkdir()
    (home / ".rind" / "settings.json").write_text(json.dumps({"apiKey": "test-key"}), encoding="utf-8")

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["RIND_HOME"] = str(home / ".rind")
    # Keep the child interpreter's user-site packages visible even though HOME
    # is redirected; otherwise imports installed under the real HOME break.
    env["PYTHONUSERBASE"] = os.environ.get("PYTHONUSERBASE") or str(Path.home() / ".local")
    process = subprocess.Popen(
        [sys.executable, "main.py", "app-server", "--stdio", "--cwd", str(workspace)],
        cwd=PROJECT_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        assert process.stdin and process.stdout

        def read_response(timeout=5):
            result = []
            reader = threading.Thread(target=lambda: result.append(process.stdout.readline()), daemon=True)
            reader.start()
            reader.join(timeout)
            assert not reader.is_alive(), "Runtime did not return a response in time."
            return json.loads(result[0])

        process.stdin.write(json.dumps({"kind": "request", "request_id": "init", "method": "initialize"}) + "\n")
        process.stdin.flush()
        initialize = read_response()
        assert initialize.get("kind") == "response", initialize
        session_id = initialize["result"]["session_id"]
        assert isinstance(session_id, str) and session_id

        process.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": "status",
                    "method": "rind/command/execute",
                    "params": {"session_id": session_id, "input": "/status"},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        status = read_response()
        assert status.get("request_id") == "status", status
        assert status.get("result", {}).get("display", {}).get("type") == "status", status

        process.stdin.write(
            json.dumps(
                {
                    "kind": "request",
                    "request_id": "missing-session",
                    "method": "session/replay",
                    "params": {},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        missing_session = read_response()
        assert missing_session["error"]["type"] == "InvalidRequest", missing_session

        process.stdin.write(json.dumps({"kind": "request", "request_id": "bye", "method": "shutdown"}) + "\n")
        process.stdin.flush()
        shutdown = read_response()
        assert shutdown.get("result") == {"ok": True}, shutdown

        process.wait(timeout=20)
        assert process.returncode == 0
    finally:
        process.kill()


class _TextStream:
    def __init__(self):
        self.calls = []

    def reconfigure(self, **kwargs):
        self.calls.append(kwargs)


def test_configure_utf8_stdio_pins_protocol_stream_encoding(monkeypatch):
    streams = [_TextStream(), _TextStream(), _TextStream()]
    monkeypatch.setattr(sys, "stdin", streams[0])
    monkeypatch.setattr(sys, "stdout", streams[1])
    monkeypatch.setattr(sys, "stderr", streams[2])

    configure_utf8_stdio()

    assert [stream.calls for stream in streams] == [
        [{"encoding": "utf-8", "errors": "replace"}],
        [{"encoding": "utf-8", "errors": "replace"}],
        [{"encoding": "utf-8", "errors": "replace"}],
    ]


def test_configure_stdio_server_signals_ignores_console_sigint(monkeypatch):
    calls = []

    def fake_signal(signum, handler):
        calls.append((signum, handler))

    monkeypatch.setattr(signal, "signal", fake_signal)
    configure_stdio_server_signals()

    assert calls == [(signal.SIGINT, signal.SIG_IGN)]


def test_schedule_ingest_delivers_on_live_loop():
    loop = asyncio.new_event_loop()
    try:
        received = []

        async def ingest(value):
            received.append(value)

        future = _schedule_ingest(loop, ingest, "line")
        assert future is not None

        async def await_delivery():
            await asyncio.wrap_future(future)

        loop.run_until_complete(await_delivery())
        assert received == ["line"]
    finally:
        loop.close()


def test_schedule_ingest_drops_delivery_after_loop_close():
    loop = asyncio.new_event_loop()
    loop.close()

    async def ingest():
        raise AssertionError("dropped delivery must never run")

    assert _schedule_ingest(loop, ingest) is None
