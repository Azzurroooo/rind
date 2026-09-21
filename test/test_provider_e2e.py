"""End-to-end provider journey over a real app-server stdio subprocess.

Drives the same JSONL surface the CLI speaks: initialize without
credentials, /login with the worker-initiated secret prompt, model listing
from the endpoint catalog, one tool-call turn, atomic model/set, logout.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import asyncio
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from helpers.fake_gemini_server import FakeGeminiServer
from helpers.fake_openai_server import FakeOpenAIServer
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.persistence.message_projector import MISSING_TOOL_RESULT_CONTENT


class _AppServerProcess:
    def __init__(self, workspace: Path, rind_home: Path, extra_args: list[str] | None = None):
        env = dict(os.environ)
        env["RIND_HOME"] = str(rind_home)
        env["PYTHONIOENCODING"] = "utf-8"
        self.lines: list[dict] = []
        self._lock = threading.Lock()
        self._stderr: list[str] = []
        runtime = os.environ.get("RIND_TEST_RUNTIME")
        command = [runtime] if runtime else [sys.executable, "main.py"]
        self.process = subprocess.Popen(
            [*command, "app-server", "--stdio", "--cwd", str(workspace), *(extra_args or [])],
            cwd=PROJECT_ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self._lock:
                self.lines.append(message)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self._stderr.append(line)

    def send(self, request_id, method: str, params: dict | None = None) -> None:
        assert self.process.stdin is not None
        payload = {"kind": "request", "request_id": request_id, "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def wait_for(self, predicate, timeout: float = 30.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                found = next((message for message in self.lines if predicate(message)), None)
            if found is not None:
                return found
            if self.process.poll() is not None:
                raise AssertionError(f"app-server exited early: {self.process.returncode}\n{self._stderr[-5:]}")
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for message; got: {json.dumps(self.lines[-8:], ensure_ascii=False)}")

    def response(self, request_id) -> dict:
        return self.wait_for(
            lambda message: message.get("kind") == "response" and message.get("request_id") == request_id
        )

    def close(self) -> None:
        try:
            self.send("bye", "shutdown")
            self.response("bye")
            self.process.wait(timeout=10)
        finally:
            self.process.kill()


def test_provider_login_model_and_tool_turn_journey(tmp_path: Path):
    fixture = FakeOpenAIServer()
    fixture.set_models(["fake-model-a", "fake-model-b"])
    fixture.script_tool_call("read_file", {"path": "note.txt"}, then_text=["note says: hello journey"])
    fixture.script_text(["all good"])
    fixture.start()

    rind_home = tmp_path / "home"
    rind_home.mkdir()
    workspace = tmp_path / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / "note.txt").write_text("hello journey", encoding="utf-8")
    (workspace / ".rind" / "settings.json").write_text(
        json.dumps({"provider": "openai-compatible", "baseUrl": fixture.base_url, "model": "fake-model-a"}),
        encoding="utf-8",
    )

    server = _AppServerProcess(workspace, rind_home)
    try:
        server.send("init", "initialize")
        initialize = server.response("init")
        assert initialize["result"]["provider"] == "openai-compatible"
        providers = {item["id"]: item for item in initialize["result"]["providers"]}
        assert providers["openai-compatible"]["configured"] is False

        server.send("auth", "rind/auth/list", {"session_id": initialize["result"]["session_id"]})
        auth_list = server.response("auth")
        assert auth_list["result"]["providers"][0]["source"] == "none"

        server.send("login", "rind/auth/login", {
            "session_id": initialize["result"]["session_id"],
            "provider_id": "openai-compatible",
            "method": "api_key",
        })
        prompt = server.wait_for(
            lambda message: message.get("kind") == "request" and message.get("method") == "rind/auth/prompt"
        )
        assert prompt["params"]["kind"] == "secret"
        server.send(prompt["request_id"], "rind/auth/prompt", {"value": "e2e-secret-key"})
        login = server.response("login")
        assert login["result"]["ok"] is True
        assert login["result"]["models_count"] == 2
        assert login["result"]["selection"] is None  # session model already usable

        stored = json.loads((rind_home / "auth.json").read_text(encoding="utf-8"))
        assert stored["openai-compatible"]["type"] == "api_key"
        assert stored["openai-compatible"]["key"] == "e2e-secret-key"

        server.send("models", "model/list", {"session_id": initialize["result"]["session_id"]})
        models = server.response("models")["result"]
        assert [model["id"] for model in models["models"]] == ["fake-model-a", "fake-model-b"]
        # Refreshed /models entries carry no effort metadata, so the dialect default applies.
        assert models["models"][0]["reasoning_efforts"] == ["low", "medium", "high", "xhigh", "max"]
        assert models["current"] == {"provider_id": "openai-compatible", "model_id": "fake-model-a"}
        assert models["warning"] is None

        server.send("turn", "session/prompt", {
            "session_id": initialize["result"]["session_id"],
            "input": "read the note and summarize",
        })
        turn = server.response("turn")
        assert turn["result"]["ok"] is True
        events = [
            message for message in server.lines
            if message.get("kind") == "event"
            and message.get("session_id") == initialize["result"]["session_id"]
        ]
        types = [message["event"]["type"] for message in events]
        assert "tool_requested" in types and "tool_result" in types and "turn_completed" in types
        final = next(
            message["event"]["content"] for message in events
            if message["event"]["type"] == "assistant_message_completed"
        )
        assert "note says: hello journey" in final

        server.send("set", "model/set", {
            "session_id": initialize["result"]["session_id"],
            "provider_id": "openai-compatible",
            "model_id": "fake-model-b",
        })
        assert server.response("set")["result"]["model_id"] == "fake-model-b"

        server.send("logout", "rind/auth/logout", {"session_id": initialize["result"]["session_id"], "provider_id": "openai-compatible"})
        logout = server.response("logout")["result"]
        assert logout == {"ok": True, "provider_id": "openai-compatible", "deleted": True, "source": "none"}

        transcript = json.dumps(server.lines, ensure_ascii=False)
        assert "e2e-secret-key" not in transcript
    finally:
        server.close()
        fixture.stop()


def test_google_login_static_catalog_and_tool_turn_journey(tmp_path: Path):
    pytest.importorskip("google.genai")
    fixture = FakeGeminiServer()
    fixture.script_tool_call("read_file", {"path": "note.txt"}, then_text=["note says: gemini works"])
    fixture.start()

    rind_home = tmp_path / "home"
    rind_home.mkdir()
    workspace = tmp_path / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / "note.txt").write_text("gemini works", encoding="utf-8")
    (workspace / ".rind" / "settings.json").write_text(
        json.dumps({"provider": "google", "baseUrl": fixture.base_url, "model": "gemini-3-flash"}),
        encoding="utf-8",
    )

    server = _AppServerProcess(workspace, rind_home)
    try:
        server.send("init", "initialize")
        initialize = server.response("init")
        assert initialize["result"]["provider"] == "google"

        server.send("login", "rind/auth/login", {
            "session_id": initialize["result"]["session_id"],
            "provider_id": "google",
            "method": "api_key",
        })
        prompt = server.wait_for(
            lambda message: message.get("kind") == "request" and message.get("method") == "rind/auth/prompt"
        )
        assert prompt["params"]["kind"] == "secret"
        assert prompt["params"]["message"] == "Google API key"
        server.send(prompt["request_id"], "rind/auth/prompt", {"value": "e2e-gemini-key"})
        login = server.response("login")
        assert login["result"]["ok"] is True
        assert login["result"]["models_count"] == 8  # static catalog; Gemini has no OpenAI-style /models
        assert login["result"]["selection"] is None

        server.send("models", "model/list", {"session_id": initialize["result"]["session_id"]})
        models = server.response("models")["result"]
        assert {"gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-2.5-pro"} <= {model["id"] for model in models["models"]}
        assert all(model["image_input"] is None for model in models["models"])  # local fake endpoint

        server.send("turn", "session/prompt", {
            "session_id": initialize["result"]["session_id"],
            "input": "read the note and summarize",
        })
        turn = server.response("turn")
        assert turn["result"]["ok"] is True
        events = [
            message for message in server.lines
            if message.get("kind") == "event"
            and message.get("session_id") == initialize["result"]["session_id"]
        ]
        types = [message["event"]["type"] for message in events]
        assert "tool_requested" in types and "tool_result" in types and "turn_completed" in types
        final = next(
            message["event"]["content"] for message in events
            if message["event"]["type"] == "assistant_message_completed"
        )
        assert "note says: gemini works" in final

        # The follow-up request replays the function result back to Gemini,
        # with the call id Gemini 3 models require for correlation.
        replay = fixture.last_request()
        function_response = replay["contents"][-1]["parts"][0]["functionResponse"]
        assert function_response["name"] == "read_file"
        assert function_response["id"] == "fc_test_1"
        assert "gemini works" in function_response["response"]["output"]

        transcript = json.dumps(server.lines, ensure_ascii=False)
        assert "e2e-gemini-key" not in transcript
    finally:
        server.close()
        fixture.stop()


def test_resume_latest_repairs_interrupted_tool_call_journey(tmp_path: Path, monkeypatch):
    fixture = FakeOpenAIServer()
    fixture.set_models(["fake-model-a"])
    fixture.script_text(["the date call was interrupted before its result was saved"])
    fixture.start()

    rind_home = tmp_path / "home"
    rind_home.mkdir()
    (rind_home / "auth.json").write_text(
        json.dumps({"openai-compatible": {"type": "api_key", "key": "e2e-secret-key"}}),
        encoding="utf-8",
    )
    workspace = tmp_path / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / ".rind" / "settings.json").write_text(
        json.dumps({"provider": "openai-compatible", "baseUrl": fixture.base_url, "model": "fake-model-a"}),
        encoding="utf-8",
    )

    # Seed the crash state: the assistant tool call was persisted, the tool
    # result never was.
    async def _seed_orphaned_turn():
        store = JsonlSessionStore(
            session_id="e2e-orphaned-turn",
            model="fake-model-a",
            provider="openai-compatible",
            system_prompt="e2e system prompt",
            workspace_root=str(workspace),
        )
        await store.initialize()
        await store.persist_message("user", "run date")
        await store.persist_message(
            "assistant",
            "",
            meta={"tool_calls": [{"id": "call_e2e_1", "name": "bash", "raw_args": '{"command":"date"}'}]},
        )

    monkeypatch.setenv("RIND_HOME", str(rind_home))
    asyncio.run(_seed_orphaned_turn())
    monkeypatch.delenv("RIND_HOME")

    server = _AppServerProcess(workspace, rind_home, extra_args=["--resume-latest"])
    try:
        server.send("init", "initialize")
        initialize = server.response("init")
        assert initialize["result"]["session_id"] == "e2e-orphaned-turn"

        server.send("turn", "session/prompt", {
            "session_id": "e2e-orphaned-turn",
            "input": "what happened to the date command?",
        })
        turn = server.response("turn")
        assert turn["result"]["ok"] is True

        request_messages = fixture.last_request()["messages"]
        tool_index = next(
            index
            for index, message in enumerate(request_messages)
            if message.get("role") == "tool"
            and message.get("tool_call_id") == "call_e2e_1"
            and message.get("content") == MISSING_TOOL_RESULT_CONTENT
        )
        assert request_messages[tool_index - 1]["tool_calls"][0]["id"] == "call_e2e_1"
    finally:
        server.close()
        fixture.stop()


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_responses_and_anthropic_stream_and_offline_tokens(tmp_path, provider, monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import tiktoken

    query = "中文代码 abc def " * 80
    expected_tokens = len(tiktoken.get_encoding("cl100k_base").encode(
        json.dumps({"role": "user", "content": query}, ensure_ascii=False), disallowed_special=(),
    ))
    events = [
        {"type": "response.output_text.delta", "delta": "frozen protocol works", "sequence_number": 1},
        {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 10, "output_tokens": 3}}, "sequence_number": 2},
    ] if provider == "openai" else [
        {"type": "message_start", "message": {"id": "msg", "type": "message", "role": "assistant", "model": "fixture", "content": [], "usage": {"input_tokens": 10, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "frozen protocol works"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 3}},
        {"type": "message_stop"},
    ]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    workspace = tmp_path / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / ".rind" / "settings.json").write_text(json.dumps({
        "provider": provider, "apiKey": "fixture-key", "model": "fixture",
        "baseUrl": f"http://127.0.0.1:{http.server_port}/v1",
    }), encoding="utf-8")
    monkeypatch.delenv("TIKTOKEN_CACHE_DIR", raising=False)
    monkeypatch.delenv("DATA_GYM_CACHE_DIR", raising=False)
    # Model traffic stays local; tokenizer downloads cannot use the network.
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    server = _AppServerProcess(workspace, tmp_path / "home")
    try:
        server.send("init", "initialize")
        sid = server.response("init")["result"]["session_id"]
        server.send("turn", "session/prompt", {"session_id": sid, "input": query})
        assert server.response("turn")["result"]["ok"]
        assert any(message.get("event", {}).get("content") == "frozen protocol works" for message in server.lines)
        server.send("context", "rind/context/inspect", {"session_id": sid})
        sections = server.response("context")["result"]["breakdown"]["sections"]
        assert next(section for section in sections if section["key"] == "chat_user")["tokens"] == expected_tokens
    finally:
        server.close()
        http.shutdown()
        http.server_close()
        thread.join()


def test_web_extraction_through_worker_and_http_proxy(tmp_path, monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    html = ("<html><body><article><h1>Fixture article</h1><p>"
            + "中文正文 and English documentation. " * 40
            + "</p><table><tr><th>Name</th><th>Value</th></tr><tr><td>row-key</td><td>42</td></tr></table>"
            + "<pre><code>print('sample-code')</code></pre></article></body></html>").encode()
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            received.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    fixture = FakeOpenAIServer()
    fixture.script_tool_call("fetch_web_page", {"url": "http://rind-fixture.invalid/article"}, then_text=["page extracted"])
    fixture.start()
    workspace = tmp_path / "workspace"
    (workspace / ".rind").mkdir(parents=True)
    (workspace / ".rind" / "settings.json").write_text(json.dumps({
        "provider": "openai-compatible", "baseUrl": fixture.base_url,
        "model": "fixture", "apiKey": "fixture-key",
    }), encoding="utf-8")
    monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_port}")
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{proxy.server_port}")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    server = _AppServerProcess(workspace, tmp_path / "home")
    try:
        server.send("init", "initialize")
        sid = server.response("init")["result"]["session_id"]
        server.send("turn", "session/prompt", {"session_id": sid, "input": "fetch the article"})
        assert server.response("turn")["result"]["ok"]
        messages = fixture.last_request()["messages"]
        content = next(message["content"] for message in messages if message["role"] == "tool")
        assert "中文正文" in content
        assert "row-key" in content
        assert "sample-code" in content
        assert received == ["http://rind-fixture.invalid/article"]
    finally:
        server.close()
        fixture.stop()
        proxy.shutdown()
        proxy.server_close()
        thread.join()
