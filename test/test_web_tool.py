import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.cancellation import CancellationTokenSource
from agent.infrastructure.tools.impl.tools import pdf_ops, web


def parse_payload(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return payload


def test_search_web_rejects_empty_query() -> None:
    payload = parse_payload(web.search_web("  "))

    if payload.get("ok") is not False:
        raise AssertionError(f"Expected validation error, got: {payload}")
    if payload.get("error_type") != "ValidationError":
        raise AssertionError(f"Expected ValidationError, got: {payload}")


def test_search_web_clamps_max_results() -> None:
    calls = []
    original_bing = web._search_bing
    original_baidu = web._search_baidu
    original_ddg = web._search_ddg

    def fake_bing(query: str, max_results: int):
        calls.append((query, max_results))
        return [{"title": "Result", "url": "https://example.test", "snippet": ""}]

    try:
        web._search_bing = fake_bing
        web._search_baidu = lambda query, max_results: []
        web._search_ddg = lambda query, max_results: []

        payload = parse_payload(web.search_web("query", max_results=999))
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


def test_sync_web_and_pdf_tools_return_cancelled_payload() -> None:
    source = CancellationTokenSource()
    source.cancel("unit test")

    for raw in (
        web.search_web("query", _cancellation_token=source.token),
        web.fetch_web_page("https://example.test", _cancellation_token=source.token),
        pdf_ops.read_pdf("missing.pdf", _cancellation_token=source.token),
    ):
        payload = parse_payload(raw)
        if payload.get("ok") is not False or payload.get("error_type") != "Cancelled":
            raise AssertionError(f"Expected Cancelled payload, got: {payload}")


def main() -> int:
    test_search_web_rejects_empty_query()
    test_search_web_clamps_max_results()
    test_sync_web_and_pdf_tools_return_cancelled_payload()
    print("Web tool tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
