"""Guard against repeated empty background-shell polling."""

from __future__ import annotations

import json

from agent.domain import tool_error


class BashOutputPollingGuard:
    def __init__(self) -> None:
        self._counts_by_turn: dict[str, dict[str, int]] = {}

    def counts_for_turn(self, turn_id: str) -> dict[str, int]:
        if not turn_id:
            return {}
        if len(self._counts_by_turn) > 32:
            self._counts_by_turn.clear()
        return self._counts_by_turn.setdefault(turn_id, {})

    def pre_guard(self, tool_name: str, parsed_args: dict, counts: dict[str, int]) -> str | None:
        if tool_name != "bash_output":
            return None
        bg_id = str(parsed_args.get("bg_id") or "")
        if not bg_id or counts.get(bg_id, 0) < 6:
            return None
        counts[bg_id] = counts.get(bg_id, 0) + 1
        return self._repeated_empty_poll_error(bg_id, counts[bg_id])

    def record_observation(self, tool_name: str, tool_result: str, counts: dict[str, int]) -> None:
        if tool_name != "bash_output":
            return
        try:
            payload = json.loads(tool_result)
        except Exception:
            return
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return
        data = payload.get("data")
        if not isinstance(data, dict):
            return
        bg_id = str(data.get("bg_id") or "")
        if not bg_id:
            return
        empty_running = (
            data.get("status") == "running"
            and data.get("no_new_output") is True
            and not data.get("stdout")
            and not data.get("stderr")
        )
        counts[bg_id] = counts.get(bg_id, 0) + 1 if empty_running else 0

    def _repeated_empty_poll_error(self, bg_id: str, count: int) -> str:
        return tool_error(
            "bash_output",
            f"Background task {bg_id} is still running with no new output. Stop calling bash_output for this task now; return this bg_id to the user and tell them they can ask to check it again later.",
            "RepeatedEmptyPoll",
            meta={
                "bg_id": bg_id,
                "empty_observation_count": count,
                "suggested_next_wait_ms": 120000 if count <= 3 else 300000,
            },
        )
