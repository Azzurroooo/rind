"""A scriptable OpenAI-compatible SSE server for user-journey tests.

The worker under test talks to this over real HTTP with the openai SDK, so a
full agent turn (streaming deltas, tool calls, refusals) runs end-to-end
without any network. Threaded + stdlib only.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeOpenAIServer:
    """Queue of scripted responses; records every request body it receives."""

    def __init__(self):
        self._lock = threading.Lock()
        self._script: list[dict] = []
        self.requests: list[dict] = []
        self.port = 0
        self._server = None
        self._thread = None

    # -- scripting -----------------------------------------------------------

    def script_text(self, chunks: list[str], *, delay_ms: int = 10, finish: str = "stop") -> None:
        """One assistant message streamed as content deltas."""
        with self._lock:
            self._script.append({"kind": "text", "chunks": chunks, "delay_ms": delay_ms, "finish": finish})

    def script_tool_call(self, name: str, arguments: dict | str, *, then_text: list[str] | None = None) -> None:
        """One assistant message that is a single complete tool call."""
        with self._lock:
            self._script.append({"kind": "tool_call", "name": name, "arguments": arguments})
            if then_text is not None:
                self._script.append({"kind": "text", "chunks": then_text, "delay_ms": 5, "finish": "stop"})

    def script_error(self, status: int = 500) -> None:
        with self._lock:
            self._script.append({"kind": "error", "status": status})
    # -- lifecycle -----------------------------------------------------------

    def start(self, port: int = 0) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                if not self.path.endswith("/chat/completions"):
                    self._reply(404, {"error": "not found"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = {"_raw": raw.decode("utf-8", "replace")}
                with server._lock:
                    server.requests.append(body)
                    script = server._script.pop(0) if server._script else {"kind": "text", "chunks": ["(no script)"], "delay_ms": 1, "finish": "stop"}
                    import sys as _sys
                    first_user = next((m.get("content") for m in body.get("messages", []) if m.get("role") == "user"), "")
                    preview = first_user if isinstance(first_user, str) else json.dumps(first_user, ensure_ascii=False)[:60]
                    print(f"[fake-openai] req#{len(server.requests)} user=...{str(preview)[-30:]!r} script={script['kind']}", file=_sys.stderr, flush=True)
                if script["kind"] == "error":
                    self._reply(script["status"], {"error": {"message": "scripted failure"}})
                    return
                if not body.get("stream"):
                    # Non-streaming callers (compaction) expect one JSON completion.
                    prompt_chars = sum(len(str(m.get("content") or "")) for m in body.get("messages", []))
                    content = "".join(script.get("chunks", [])) if script["kind"] == "text" else ""
                    self._reply(200, {
                        "id": "chatcmpl-test",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": str(body.get("model") or "fake-model"),
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": content or "(no script)"},
                            "finish_reason": "stop",
                        }],
                        "usage": {
                            "prompt_tokens": int(prompt_chars / 3.5) + 2,
                            "completion_tokens": 21,
                            "total_tokens": int(prompt_chars / 3.5) + 23,
                            "prompt_tokens_details": {"cached_tokens": 0},
                            "completion_tokens_details": {"reasoning_tokens": 0},
                        },
                    })
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                # Fresh TCP per request: an aborted (cancelled) stream must never
                # poison a pooled keep-alive connection for the next journey.
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                request_id = "chatcmpl-test"
                created = int(time.time())
                model = str(body.get("model") or "fake-model")

                def emit(payload):
                    self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()

                if script["kind"] == "tool_call":
                    arguments = script["arguments"]
                    arguments = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
                    emit(self._chunk(request_id, created, model, {"role": "assistant", "content": None, "tool_calls": [
                        {"index": 0, "id": "call_test_1", "type": "function",
                         "function": {"name": script["name"], "arguments": arguments}},
                    ]}))
                    emit(self._chunk(request_id, created, model, {}, finish="tool_calls"))
                    if body.get("stream_options", {}).get("include_usage"):
                        prompt_chars = sum(len(str(m.get("content") or "")) for m in body.get("messages", []))
                        emit({
                            "id": request_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [],
                            "usage": {
                                "prompt_tokens": int(prompt_chars / 3.5) + 2,
                                "completion_tokens": 21,
                                "total_tokens": int(prompt_chars / 3.5) + 23,
                                "prompt_tokens_details": {"cached_tokens": 0},
                                "completion_tokens_details": {"reasoning_tokens": 0},
                            },
                        })
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                first = True
                for piece in script["chunks"]:
                    delta = {"role": "assistant", "content": piece} if first else {"content": piece}
                    emit(self._chunk(request_id, created, model, delta))
                    first = False
                    if script["delay_ms"]:
                        time.sleep(script["delay_ms"] / 1000.0)
                emit(self._chunk(request_id, created, model, {}, finish=script.get("finish", "stop")))
                if body.get("stream_options", {}).get("include_usage"):
                    # Providers echo measured usage on a choices-free final chunk.
                    prompt_chars = sum(len(str(m.get("content") or "")) for m in body.get("messages", []))
                    emit({
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [],
                        "usage": {
                            "prompt_tokens": int(prompt_chars / 3.5) + 2,
                            "completion_tokens": 21,
                            "total_tokens": int(prompt_chars / 3.5) + 23,
                            "prompt_tokens_details": {"cached_tokens": 0},
                            "completion_tokens_details": {"reasoning_tokens": 0},
                        },
                    })
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def _reply(self, status: int, payload: dict):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                self.wfile.write(body)

            @staticmethod
            def _chunk(request_id, created, model, delta, *, finish=None):
                return {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        if self._thread:
            self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def request_count(self) -> int:
        with self._lock:
            return len(self.requests)

    def last_request(self) -> dict:
        with self._lock:
            return self.requests[-1] if self.requests else {}
