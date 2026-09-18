import json
import os
import sys
from pathlib import Path

import pytest
from agent.infrastructure.tools.builtin.web_sessions import WebSessions

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.tools.builtin import web


def parse_payload(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return payload


def test_search_web_rejects_empty_query(http_sessions) -> None:
    payload = parse_payload(web.search_web("  ", _http_sessions=http_sessions))

    if payload.get("ok") is not False:
        raise AssertionError(f"Expected validation error, got: {payload}")
    if payload.get("error_type") != "ValidationError":
        raise AssertionError(f"Expected ValidationError, got: {payload}")


def test_search_web_clamps_max_results(http_sessions) -> None:
    calls = []
    original_bing = web._search_bing
    original_baidu = web._search_baidu
    original_ddg = web._search_ddg

    def fake_bing(query: str, max_results: int, session):
        calls.append((query, max_results))
        return [{"title": "Result", "url": "https://example.test", "snippet": ""}]

    try:
        web._search_bing = fake_bing
        web._search_baidu = lambda query, max_results, session: []
        web._search_ddg = lambda query, max_results, session: []

        payload = parse_payload(web.search_web("query", max_results=999, _http_sessions=http_sessions))
    finally:
        web._search_bing = original_bing
        web._search_baidu = original_baidu
        web._search_ddg = original_ddg

    if payload.get("ok") is not True:
        raise AssertionError(f"Expected successful search payload, got: {payload}")
    if calls != [("query", 10)]:
        raise AssertionError(f"Expected max_results to be clamped to 10, got: {calls}")
    meta = payload.get("meta") or {}
    if meta.get("matches") != 1:
        raise AssertionError(f"Expected one match, got: {payload}")


def test_sync_web_tools_return_cancelled_payload(http_sessions) -> None:
    source = CancellationTokenSource()
    source.cancel("unit test")

    for raw in (
        web.search_web("query", _cancellation_token=source.token, _http_sessions=http_sessions),
        web.fetch_web_page("https://example.test", _cancellation_token=source.token, _http_sessions=http_sessions),
    ):
        payload = parse_payload(raw)
        if payload.get("ok") is not False or payload.get("error_type") != "Cancelled":
            raise AssertionError(f"Expected Cancelled payload, got: {payload}")



@pytest.fixture
def http_sessions():
    sessions = WebSessions()
    yield sessions
    sessions.close()


class Response:
    def __init__(self, status=200, headers=None, body=b"<p>test</p>", error=None, cancel=None):
        self.status_code = status
        self.headers = headers or {}
        self.body = body
        self.error = error
        self.cancel = cancel
        self.closed = False
        self.encoding = "utf-8"
        self.text = body.decode()

    def close(self):
        self.closed = True

    def raise_for_status(self):
        if self.error:
            raise self.error

    def iter_content(self, chunk_size):
        if self.cancel:
            self.cancel.cancel("cancel download")
        yield self.body


@pytest.mark.parametrize("case", ["success", "status_error", "length_limit", "stream_limit", "cancel", "redirect_limit"])
def test_fetch_closes_every_response(case, http_sessions, monkeypatch):
    from types import SimpleNamespace

    token = CancellationTokenSource()
    response = Response()
    if case == "status_error":
        response.error = RuntimeError("server failed")
    elif case == "length_limit":
        response.headers = {"content-length": str(web._MAX_RESPONSE_BYTES + 1)}
    elif case == "stream_limit":
        response.body = b"x" * (web._MAX_RESPONSE_BYTES + 1)
    elif case == "cancel":
        response.cancel = token
    redirects = [Response(302, {"location": "/next"}) for _ in range(6 if case == "redirect_limit" else 1)]
    responses = redirects if case == "redirect_limit" else redirects + [response]
    remaining = iter(responses)
    monkeypatch.setattr(http_sessions, "_create_session", lambda: SimpleNamespace(
        get=lambda *args, **kwargs: next(remaining), close=lambda: None,
    ))
    result = parse_payload(web.fetch_web_page("https://example.test", token.token, _http_sessions=http_sessions))
    assert all(item.closed for item in responses)
    assert result["ok"] == (case == "success")
    if case in {"length_limit", "stream_limit"}:
        assert result["error_type"] == "ResponseTooLarge"
    if case == "cancel":
        assert result["error_type"] == "Cancelled"


@pytest.mark.parametrize("engine", [web._search_bing, web._search_baidu, web._search_ddg])
def test_search_closes_failed_response(engine):
    from types import SimpleNamespace

    response = Response(error=RuntimeError("failed"))
    session = SimpleNamespace(get=lambda *args, **kwargs: response, post=lambda *args, **kwargs: response)
    with pytest.raises(RuntimeError):
        engine("test", 5, session)
    assert response.closed


def test_web_sessions_lease_exclusively_and_close_outstanding_lease(monkeypatch):
    from types import SimpleNamespace
    from threading import Event, Thread

    closed = []
    closing_started = Event()
    sessions = WebSessions()

    def close_session():
        closed.append(True)
        closing_started.set()

    monkeypatch.setattr(sessions, "_create_session", lambda: SimpleNamespace(close=close_session))
    with sessions.acquire() as first:
        with sessions.acquire() as second:
            assert first is not second
        with sessions.acquire() as reused:
            assert reused is second
        closing = Thread(target=sessions.close, daemon=True)
        closing.start()
        assert closing_started.wait(1)
        assert closing.is_alive()
        assert len(closed) == 1
    closing.join(1)
    assert not closing.is_alive()
    assert len(closed) == 2
    sessions.close()
    with pytest.raises(RuntimeError):
        with sessions.acquire():
            pass
