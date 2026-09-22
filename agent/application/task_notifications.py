"""Project durable task facts only after all tool messages are closed."""
from __future__ import annotations

import json
from collections.abc import Callable

from agent.application.ports.task_store import TaskStore
from agent.application.ports.session_store import SessionStore


from agent.domain.tasks import TERMINAL_STATES


def pending_notification(record: dict) -> bool:
    return bool(record.get("event_id") and record.get("committed") and record.get("handoff")
        and not record.get("delivered") and record.get("notify") == "on_exit" and record.get("status") != "cancelled")


def task_reference(record: dict) -> dict:
    return {key: record.get(key) for key in ("task_id", "status", "notify", "origin_tool_call_id", "event_id")}


class TaskNotifications:
    def __init__(self, store: TaskStore, changed: Callable[[dict], None] | None = None,
                 request_id: Callable[[str], str | None] | None = None):
        self.store = store
        self.changed = changed
        self.request_id = request_id

    async def result_committed(self, session_id: str, tool_name: str, call_id: str, result: str) -> None:
        if tool_name not in {"bash", "task_control", "bash_output"}:
            return
        try:
            payload = json.loads(result)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict):
            return
        data = payload.get("data")
        if not payload.get("ok") or not isinstance(data, dict) or not data.get("task_id"):
            return
        record = (await self.store.records(session_id)).get(data["task_id"])
        if record is None:
            return
        changes = {}
        if tool_name == "bash" and record.get("origin_tool_call_id") == call_id:
            changes.update(committed=True, handoff=data.get("status") not in TERMINAL_STATES)
        if data.get("status") in TERMINAL_STATES:
            changes["delivered"] = True
        changes = {key: value for key, value in changes.items() if record.get(key) != value}
        if changes:
            updated = await self.store.update(session_id, data["task_id"], **changes)
            if self.changed:
                self.changed(updated)

    async def deliver(self, session: SessionStore) -> int:
        records = await self.store.records(session.session_id)
        if not records:
            return 0
        messages = await session.load_messages()
        pending_calls = set()
        projected = set()
        for message in messages:
            meta = message.get("meta") or {}
            if message.get("role") == "assistant":
                pending_calls.update(call["id"] for call in meta.get("tool_calls", []) if call.get("id"))
            if message.get("role") == "tool":
                pending_calls.discard(message.get("tool_call_id"))
            if meta.get("kind") == "task_notification":
                projected.update(meta.get("event_ids", []))
        if pending_calls:
            return 0
        # Recover the window between tool-message persistence and journal acknowledgement.
        tool_messages = {m.get("tool_call_id"): m for m in messages if m.get("role") == "tool"}
        for tool in await session.get_tool_records(call_ids=list(tool_messages)):
            if tool.get("name") in {"task_control", "bash_output"}:
                await self.result_committed(session.session_id, tool["name"], tool["id"], str(tool.get("model_content") or "{}"))
        for record in records.values():
            origin = record.get("origin_tool_call_id")
            if not record.get("committed") and origin in tool_messages:
                tools = await session.get_tool_records(call_ids=[origin])
                if tools:
                    await self.result_committed(session.session_id, "bash", origin, str(tools[-1].get("model_content") or "{}"))
        records = await self.store.records(session.session_id)
        pending = [r for r in records.values() if pending_notification(r)]
        fresh = [r for r in pending if r["event_id"] not in projected]
        if fresh:
            facts = [{**task_reference(r), "exit_code": r.get("exit_code"), "elapsed_ms": r.get("elapsed_ms"),
                      "reason": r.get("reason"), "output_path": r.get("meta", {}).get("output_path"),
                      "output_incomplete": r.get("meta", {}).get("output_incomplete", False)} for r in fresh]
            untrusted = [{"task_id": r["task_id"], "stdout": r.get("stdout", "")[-2000:], "stderr": r.get("stderr", "")[-2000:]} for r in fresh]
            await session.persist_message("user", json.dumps({"runtime_notification": "task_completed",
                "facts": facts, "untrusted_process_output": untrusted}, ensure_ascii=False),
                meta={"kind": "task_notification", "event_ids": [r["event_id"] for r in fresh]})
        for record in pending:
            await self.store.update(session.session_id, record["task_id"], delivered=True)
        return len(fresh)

    async def references(self, session_id: str) -> list[dict]:
        return [task_reference(r) for r in (await self.store.records(session_id)).values()
                if r.get("status") not in TERMINAL_STATES or pending_notification(r)
                or (r.get("delivered") and not r.get("consumed"))]

    async def model_consumed(self, session_id: str, references: list[dict]) -> None:
        records = await self.store.records(session_id)
        for reference in references:
            record = records.get(reference["task_id"], {})
            if record.get("delivered") and not record.get("consumed"):
                await self.store.update(session_id, record["task_id"], consumed=True, continuation_error="")

    async def continuation_failed(self, session_id: str, error: str) -> None:
        for record in (await self.store.records(session_id)).values():
            if record.get("delivered") and not record.get("consumed"):
                await self.store.update(session_id, record["task_id"], continuation_error=error)
