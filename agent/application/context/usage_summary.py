"""User-level token usage summarization over ledger records."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


USAGE_SUMMARY_DEFAULT_DAYS = 7
USAGE_SUMMARY_MAX_DAYS = 365
USAGE_SUMMARY_SESSION_LIMIT = 5


def summarize_usage(
    records: list[dict],
    days: int = USAGE_SUMMARY_DEFAULT_DAYS,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Reduce ledger rows into window totals plus by-day/by-model/session views.

    Pure function: every number traces back to a raw record; nothing is derived
    beyond grouping and summing.
    """
    window_days = _window_days(days)
    end = _aware(now or datetime.now(timezone.utc))
    cutoff = end - timedelta(days=window_days)

    totals = {
        "input": 0,
        "cached": 0,
        "output": 0,
        "reasoning": 0,
        "total": 0,
        "samples": 0,
        "compactions": 0,
    }
    by_day: dict[str, int] = {}
    by_model: dict[str, dict[str, int]] = {}
    sessions: dict[str, dict[str, Any]] = {}

    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict):
            continue
        ts = _parse_ts(record.get("ts"))
        if ts is None or ts < cutoff:
            continue
        volume = _record_volume(record)
        totals["input"] += _non_negative(record.get("input_tokens"))
        totals["cached"] += _non_negative(record.get("cached_input_tokens"))
        totals["output"] += _non_negative(record.get("output_tokens"))
        totals["reasoning"] += _non_negative(record.get("reasoning_output_tokens"))
        totals["total"] += volume
        totals["samples"] += 1
        if record.get("sampling_kind") == "compact":
            totals["compactions"] += 1
        day = ts.astimezone(timezone.utc).strftime("%m-%d")
        by_day[day] = by_day.get(day, 0) + volume
        model = str(record.get("model") or "unknown")
        model_bucket = by_model.setdefault(model, {"tokens": 0, "samples": 0})
        model_bucket["tokens"] += volume
        model_bucket["samples"] += 1
        session_id = str(record.get("session_id") or "")
        if session_id:
            session = sessions.get(session_id)
            if session is None:
                session = sessions[session_id] = {
                    "session_id": session_id,
                    "updated_at": ts.isoformat(),
                    "tokens": 0,
                    "samples": 0,
                }
            session["updated_at"] = max(session["updated_at"], ts.isoformat())
            session["tokens"] += volume
            session["samples"] += 1

    return {
        "days": window_days,
        "totals": totals,
        "by_day": [
            {"day": day, "tokens": by_day[day]}
            for day in sorted(by_day, reverse=True)
        ],
        "by_model": [
            {"model": model, "tokens": bucket["tokens"], "samples": bucket["samples"]}
            for model, bucket in sorted(by_model.items(), key=lambda item: (-item[1]["tokens"], item[0]))
        ],
        "recent_sessions": sorted(
            sessions.values(),
            key=lambda session: (session["updated_at"], session["session_id"]),
            reverse=True,
        )[:USAGE_SUMMARY_SESSION_LIMIT],
    }


def _window_days(days: Any) -> int:
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        return USAGE_SUMMARY_DEFAULT_DAYS
    return min(days, USAGE_SUMMARY_MAX_DAYS)


def _record_volume(record: dict) -> int:
    total = _non_negative(record.get("total_tokens"))
    if total > 0:
        return total
    return _non_negative(record.get("input_tokens")) + _non_negative(record.get("output_tokens"))


def _non_negative(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    return _aware(parsed)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
