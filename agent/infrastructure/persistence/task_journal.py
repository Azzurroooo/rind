"""Append-only task facts, serialized across workers using the existing filelock dependency."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import time
import uuid
import threading

from filelock import FileLock, Timeout

from agent.infrastructure.paths import resolve_session_base


TERMINAL_STATES = frozenset({"completed", "failed", "cancelled", "timed_out", "lost"})


class TaskJournal:
    def __init__(self, session_root: Path):
        self.root = session_root
        self.worker_instance_id = uuid.uuid4().hex
        self._lease: FileLock | None = None
        self._lease_lock = threading.Lock()

    def _ensure_lease(self) -> None:
        if self._lease is None:
            directory = self.root / ".task-workers"
            directory.mkdir(parents=True, exist_ok=True)
            lease = FileLock(directory / f"{self.worker_instance_id}.lock", thread_local=False)
            lease.acquire(timeout=0)
            self._lease = lease

    def _owner_alive(self, owner: str) -> bool:
        if not owner or not owner.isalnum():
            return False
        path = self.root / ".task-workers" / f"{owner}.lock"
        if not path.exists():
            return False
        try:
            with FileLock(path, timeout=0):
                return False
        except Timeout:
            return True

    async def records(self, session_id: str) -> dict[str, dict]:
        return await asyncio.to_thread(self._transaction, session_id, None, None, False)

    async def save(self, session_id: str, snapshot: dict, *, create: bool = False) -> dict:
        return await asyncio.to_thread(self._transaction, session_id, snapshot["task_id"], snapshot, create)

    async def update(self, session_id: str, task_id: str, **changes) -> dict:
        return await asyncio.to_thread(self._transaction, session_id, task_id, changes, False)

    def _transaction(self, session_id: str, task_id: str | None, changes: dict | None, create: bool):
        directory = resolve_session_base(self.root, session_id)
        path = directory / "tasks.jsonl"
        if changes is None and not path.exists():
            return {}
        directory.mkdir(parents=True, exist_ok=True)
        with FileLock(str(path) + ".lock"):
            with self._lease_lock:
                self._ensure_lease()
            records = {}
            if path.exists():
                with path.open("rb") as source:
                    valid_end = 0
                    for line in source:
                        try:
                            record = json.loads(line)
                        except (ValueError, UnicodeDecodeError):
                            # Only an interrupted final append is recoverable.
                            if source.read(1):
                                raise ValueError("Corrupt task journal; refusing to execute commands.")
                            with path.open("r+b") as repair:
                                repair.truncate(valid_end)
                            break
                        records[record["task_id"]] = record
                        valid_end = source.tell()
            updates = []
            for record in records.values():
                if record["status"] not in TERMINAL_STATES and not self._owner_alive(record.get("worker_instance_id", "")):
                    record.update(status="lost", finished_at=time.time(), exit_code=None,
                        reason="Previous Worker ownership was lost; process state is unknown. Command was not restarted.",
                        event_id=f"{record['task_id']}:1")
                    updates.append(dict(record))
            if create:
                origin = changes.get("origin_tool_call_id")
                existing = next((r for r in records.values() if origin and r.get("origin_tool_call_id") == origin), None)
                if existing is not None:
                    for update in updates:
                        self._append(path, update)
                    return dict(existing)
            if changes is not None:
                record = {**records.get(task_id, {}), **changes}
                if not record.get("task_id"):
                    raise LookupError(f"Unknown task: {task_id}")
                records[task_id] = record
                updates.append(record)
            for update in updates:
                self._append(path, update)
            expired = [r for r in records.values() if r.get("finished_at") and r["finished_at"] < time.time() - 86400
                       and (r.get("delivered") or r.get("notify") == "manual") and "stdout" in r]
            if expired:
                for record in expired:
                    output_path = record.get("meta", {}).get("output_path")
                    if output_path:
                        target = Path(output_path).resolve()
                        if target.parent == (directory / "tool-output").resolve() and target.stem == record["task_id"]:
                            target.unlink(missing_ok=True)
                            target.with_suffix(".jsonl").unlink(missing_ok=True)
                    record.pop("stdout", None)
                    record.pop("stderr", None)
                    record["meta"] = {"output_incomplete": True, "output_error": "Output retention expired; task facts and deduplication identity remain available."}
                temporary = path.with_suffix(".tmp")
                try:
                    with temporary.open("w", encoding="utf-8") as output:
                        for record in records.values():
                            output.write(json.dumps(record, ensure_ascii=False) + "\n")
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
            return dict(records[task_id]) if task_id else records

    @staticmethod
    def _append(path: Path, record: dict) -> None:
        with path.open("ab") as target:
            target.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            target.flush()
            os.fsync(target.fileno())

    async def close(self) -> None:
        self.close_now()

    def close_now(self) -> None:
        if self._lease is not None:
            self._lease.release()
            self._lease = None
