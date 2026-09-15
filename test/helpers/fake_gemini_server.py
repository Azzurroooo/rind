"""A scriptable Gemini SSE server for user-journey tests.

The worker under test talks to this over real HTTP with the google-genai
SDK, so a full agent turn (streaming text, thought summaries, function
calls) runs end-to-end without any network. Threaded + stdlib only.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeGeminiServer:
    """Queue of scripted responses; records every request body it receives."""

    def __init__(self):
        self._lock = threading.Lock()
        self._script: list[dict] = []
        self.requests: list[dict] = []
        self.port = 0
        self._server = None
        self._thread = None

    # -- scripting -----------------------------------------------------------

    def script_text(self, chunks: list[str], *, thought: str | None = None, finish: str = "STOP") -> None:
        """One assistant message streamed as text deltas plus optional thought."""
        with self._lock:
            self._script.append({"kind": "text", "chunks": chunks, "thought": thought, "finish": finish})

    def script_tool_call(self, name: str, arguments: dict | str, call_id: str = "fc_test_1", *, then_text: list[str] | None = None) -> None:
        """One assistant message that is a single complete function call."""
        with self._lock:
            self._script.append({"kind": "tool_call", "name": name, "arguments": arguments, "call_id": call_id})
            if then_text is not None:
                self._script.append({"kind": "text", "chunks": then_text, "thought": None, "finish": "STOP"})

    # -- lifecycle -----------------------------------------------------------

    def start(self, port: int = 0) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                if not (":streamGenerateContent" in self.path or ":generateContent" in self.path):
                    self._reply(404, {"error": {"message": "not found"}})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = {"_raw": raw.decode("utf-8", "replace")}
                with server._lock:
                    server.requests.append(body)
                    script = server._script.pop(0) if server._script else {"kind": "text", "chunks": ["(no script)"], "thought": None, "finish": "STOP"}
                if ":generateContent" in self.path:
                    # Non-streaming callers (compaction) expect one JSON response.
                    self._reply(200, {
                        "candidates": [{
                            "content": {"parts": [{"text": "".join(script.get("chunks", []))}]},
                            "finishReason": "STOP",
                            "index": 0,
                        }],
                        "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 8},
                    })
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                # Fresh TCP per request so an aborted stream never poisons a
                # pooled keep-alive connection for the next journey.
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()

                def emit(payload):
                    self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()

                def part(part_value):
                    return {"candidates": [{"content": {"parts": [part_value], "role": "model"}, "index": 0}]}

                if script["kind"] == "tool_call":
                    arguments = script["arguments"]
                    arguments = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
                    emit(part({"functionCall": {"id": script["call_id"], "name": script["name"], "args": json.loads(arguments)}}))
                    emit({"candidates": [{"content": {"role": "model"}, "finishReason": "STOP", "index": 0}],
                          "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "thoughtsTokenCount": 3}})
                    return
                if script["thought"]:
                    emit(part({"text": script["thought"], "thought": True}))
                for piece in script["chunks"]:
                    emit(part({"text": piece}))
                    time.sleep(0.01)
                emit({"candidates": [{"content": {"role": "model"}, "finishReason": script["finish"], "index": 0}],
                      "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}})

            def _reply(self, status: int, payload: dict):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                self.wfile.write(body)

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
        return f"http://127.0.0.1:{self.port}/v1beta"

    def last_request(self) -> dict:
        with self._lock:
            return self.requests[-1] if self.requests else {}
