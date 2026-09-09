"""Usage summary reduction rules over ledger records."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.context.usage_summary import summarize_usage


NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)


def _record(ts, *, model="m1", session_id="s1", kind="assistant", total=100, **overrides):
    record = {
        "ts": ts,
        "model": model,
        "session_id": session_id,
        "sampling_kind": kind,
        "input_tokens": 60,
        "cached_input_tokens": 20,
        "output_tokens": 40,
        "reasoning_output_tokens": 10,
        "total_tokens": total,
    }
    record.update(overrides)
    return record


def _iso(dt):
    return dt.isoformat()


def test_records_group_by_day_within_the_window():
    records = [
        _record(_iso(NOW - timedelta(hours=1)), total=300),
        _record(_iso(NOW - timedelta(days=1, hours=2)), total=200),
        _record(_iso(NOW - timedelta(days=2, hours=3)), total=100),
    ]

    summary = summarize_usage(records, 7, now=NOW)

    assert summary["days"] == 7
    assert summary["totals"]["samples"] == 3
    assert summary["totals"]["total"] == 600
    assert [row["day"] for row in summary["by_day"]] == ["09-10", "09-09", "09-08"]
    assert [row["tokens"] for row in summary["by_day"]] == [300, 200, 100]


def test_days_filter_boundary_keeps_today_and_drops_day_eight():
    inside = _record(_iso(NOW - timedelta(days=7)), total=50)
    outside = _record(_iso(NOW - timedelta(days=8)), total=500)

    summary = summarize_usage([inside, outside], 7, now=NOW)

    assert summary["totals"]["samples"] == 1
    assert summary["totals"]["total"] == 50
    assert [row["day"] for row in summary["by_day"]] == ["09-03"]


def test_by_model_adds_up_and_orders_by_volume():
    records = [
        _record(_iso(NOW), model="big", total=900),
        _record(_iso(NOW), model="big", total=100),
        _record(_iso(NOW), model="small", total=50),
    ]

    summary = summarize_usage(records, 7, now=NOW)

    assert [(row["model"], row["tokens"], row["samples"]) for row in summary["by_model"]] == [
        ("big", 1000, 2),
        ("small", 50, 1),
    ]
    assert sum(row["tokens"] for row in summary["by_model"]) == summary["totals"]["total"]


def test_compaction_samples_are_counted_separately():
    records = [
        _record(_iso(NOW), kind="assistant"),
        _record(_iso(NOW), kind="compact"),
        _record(_iso(NOW), kind="compact"),
    ]

    summary = summarize_usage(records, 7, now=NOW)

    assert summary["totals"]["samples"] == 3
    assert summary["totals"]["compactions"] == 2


def test_recent_sessions_take_the_latest_five():
    records = []
    for index in range(7):
        records.append(
            _record(
                _iso(NOW - timedelta(hours=index)),
                session_id=f"s{index}",
                total=10 + index,
            )
        )

    summary = summarize_usage(records, 7, now=NOW)

    assert [row["session_id"] for row in summary["recent_sessions"]] == ["s0", "s1", "s2", "s3", "s4"]
    assert summary["recent_sessions"][0]["tokens"] == 10
    assert summary["recent_sessions"][0]["updated_at"] == _iso(NOW)


def test_totals_reconcile_with_raw_rows():
    records = [
        _record(_iso(NOW), total=120, input_tokens=80, cached_input_tokens=30, output_tokens=40, reasoning_output_tokens=7),
        _record(_iso(NOW - timedelta(days=1)), total=60, input_tokens=40, cached_input_tokens=10, output_tokens=20, reasoning_output_tokens=3),
    ]

    summary = summarize_usage(records, 7, now=NOW)

    totals = summary["totals"]
    assert totals["input"] == 120
    assert totals["cached"] == 40
    assert totals["output"] == 60
    assert totals["reasoning"] == 10
    assert totals["total"] == 180


def test_day_buckets_follow_the_record_own_offset():
    # 01:00 on 09-10 in UTC+8 is 17:00 on 09-09 in UTC: a user's local calendar
    # must win, so the row lands on their day, not the server's.
    record = _record("2026-09-10T01:00:00+08:00", total=77)

    summary = summarize_usage([record], 7, now=NOW)

    assert [row["day"] for row in summary["by_day"]] == ["09-10"]
    assert summary["by_day"][0]["tokens"] == 77


def test_empty_ledger_yields_an_all_zero_structure():
    summary = summarize_usage([], 7, now=NOW)

    assert summary["days"] == 7
    assert summary["totals"] == {
        "input": 0,
        "cached": 0,
        "output": 0,
        "reasoning": 0,
        "total": 0,
        "samples": 0,
        "compactions": 0,
    }
    assert summary["by_day"] == []
    assert summary["by_model"] == []
    assert summary["recent_sessions"] == []


def test_malformed_records_are_ignored():
    records = [
        "not-a-dict",
        {"no_ts": True},
        _record(_iso(NOW), total=42),
    ]

    summary = summarize_usage(records, 7, now=NOW)

    assert summary["totals"]["samples"] == 1
    assert summary["totals"]["total"] == 42
