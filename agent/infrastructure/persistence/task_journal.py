"""Append-only task facts and a bounded, process-local index."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import uuid

from filelock import FileLock, Timeout

from agent.domain.tasks import TERMINAL_STATES
from agent.infrastructure.paths import resolve_session_base


@dataclass
class _SessionIndex:
    identity: tuple[int, int] | None = None
    size: int = 0
    modified: int = 0
    relevant_complete: bool = True
    maintained_at: float | None = None
    origins: int = 0


class TaskJournal:
    TASK_CACHE_LIMIT = 256
    SESSION_CACHE_LIMIT = 32
    MAINTENANCE_INTERVAL = 3600

    def __init__(self, session_root: Path):
        self.root = session_root
        self.worker_instance_id = uuid.uuid4().hex
        self._lease: FileLock | None = None
        self._lock = threading.RLock()
        self._sessions: OrderedDict[str, _SessionIndex] = OrderedDict()
        self._tasks: OrderedDict[tuple[str, str], tuple[int, dict]] = OrderedDict()

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
        if owner == self.worker_instance_id and self._lease is not None:
            return True
        path = self.root / ".task-workers" / f"{owner}.lock"
        if not path.exists():
            return False
        try:
            with FileLock(path, timeout=0):
                return False
        except Timeout:
            return True

    async def records(self, session_id: str) -> dict[str, dict]:
        return await asyncio.to_thread(self._transaction, session_id, "all")

    async def relevant(self, session_id: str) -> dict[str, dict]:
        return await asyncio.to_thread(self._transaction, session_id, "relevant")

    async def get(self, session_id: str, task_id: str) -> dict | None:
        return await asyncio.to_thread(self._transaction, session_id, "get", task_id)

    async def save(self, session_id: str, snapshot: dict, *, create: bool = False) -> dict:
        return await asyncio.to_thread(self._transaction, session_id, "save", snapshot["task_id"], snapshot, create)

    async def update(self, session_id: str, task_id: str, **changes) -> dict:
        return await asyncio.to_thread(self._transaction, session_id, "save", task_id, changes)

    async def maintain(self, session_id: str) -> None:
        await asyncio.to_thread(self._transaction, session_id, "maintain")

    @staticmethod
    def _relevant(record: dict) -> bool:
        return (record.get("status") not in TERMINAL_STATES
                or (record.get("handoff") and (not record.get("delivered")
                    or not record.get("consumed"))))

    @staticmethod
    def _summary(record: dict) -> dict:
        return {k: v for k, v in record.items() if k not in {"stdout", "stderr", "records"}}

    def _remember(self, session_id: str, offset: int, record: dict) -> None:
        key = session_id, record["task_id"]
        self._tasks[key] = offset, self._summary(record)
        self._tasks.move_to_end(key)
        origin = record.get("origin_tool_call_id")
        if origin:
            self._sessions[session_id].origins |= 1 << self._origin_bit(origin)
        while len(self._tasks) > self.TASK_CACHE_LIMIT:
            victim = next((k for k, (_, r) in self._tasks.items() if not self._relevant(r)), None)
            if victim is None:
                victim = next(iter(self._tasks))
                self._sessions[victim[0]].relevant_complete = False
            self._tasks.pop(victim)

    def _scan(self, path: Path, session_id: str, index: _SessionIndex) -> None:
        stat = path.stat()
        identity = stat.st_dev, stat.st_ino
        if index.identity != identity or stat.st_size < index.size or (stat.st_size == index.size and stat.st_mtime_ns != index.modified):
            for key in [k for k in self._tasks if k[0] == session_id]:
                self._tasks.pop(key)
            index.identity = identity
            index.size = 0
            index.relevant_complete = True
            index.origins = 0
        if stat.st_size == index.size:
            return
        with path.open("rb") as source:
            source.seek(index.size)
            while source.tell() < stat.st_size:
                offset = source.tell()
                line = source.readline()
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    if source.tell() != stat.st_size:
                        raise ValueError("Corrupt task journal; refusing to execute commands.")
                    with path.open("r+b") as repair:
                        repair.truncate(offset)
                    break
                self._remember(session_id, offset, record)
                index.size = source.tell()
                if not line.endswith(b"\n"):
                    with path.open("ab") as repair:
                        repair.write(b"\n")
                        repair.flush()
                        os.fsync(repair.fileno())
        stat = path.stat()
        index.size = stat.st_size
        index.modified = stat.st_mtime_ns

    def _find(self, path: Path, session_id: str, *, task_id: str | None = None, origin: str | None = None) -> dict | None:
        found = None
        with path.open("rb") as source:
            while True:
                offset = source.tell()
                line = source.readline()
                if not line:
                    break
                record = json.loads(line)
                if (task_id and record.get("task_id") == task_id) or (origin and record.get("origin_tool_call_id") == origin):
                    found = record
                    self._remember(session_id, offset, record)
        return found

    @staticmethod
    def _origin_bit(origin: str) -> int:
        return int.from_bytes(hashlib.blake2b(origin.encode(), digest_size=4).digest(), "big") % 65536

    @staticmethod
    def _all(path: Path) -> dict[str, dict]:
        records = {}
        with path.open("rb") as source:
            for line in source:
                record = json.loads(line)
                records[record["task_id"]] = record
        return records

    def _cached(self, path: Path, session_id: str, task_id: str) -> dict | None:
        entry = self._tasks.get((session_id, task_id))
        if entry is None:
            return self._find(path, session_id, task_id=task_id)
        self._tasks.move_to_end((session_id, task_id))
        with path.open("rb") as source:
            source.seek(entry[0])
            return json.loads(source.readline())

    def _scan_relevant(self, path: Path, session_id: str, index: _SessionIndex) -> dict:
        latest = {}
        with path.open("rb") as source:
            while line := source.readline():
                record = json.loads(line)
                task_id = record["task_id"]
                if self._relevant(record):
                    latest[task_id] = source.tell() - len(line), self._summary(record)
                else:
                    latest.pop(task_id, None)
        for key in [k for k in self._tasks if k[0] == session_id]:
            self._tasks.pop(key)
        index.relevant_complete = True
        for offset, record in latest.values():
            self._remember(session_id, offset, record)
        return {key: record for key, (_, record) in latest.items()}

    def _write(self, path: Path, session_id: str, index: _SessionIndex, record: dict) -> None:
        offset = path.stat().st_size if path.exists() else 0
        self._append(path, record)
        self._remember(session_id, offset, record)
        stat = path.stat()
        index.identity = stat.st_dev, stat.st_ino
        index.size = stat.st_size
        index.modified = stat.st_mtime_ns

    def _recover(self, path: Path, session_id: str, index: _SessionIndex, records: dict) -> dict:
        owners = {}
        for task_id, record in records.items():
            if record.get("status") in TERMINAL_STATES:
                continue
            owner = record.get("worker_instance_id", "")
            if owner not in owners:
                owners[owner] = self._owner_alive(owner)
            if not owners[owner]:
                record = {**record, "status": "lost", "finished_at": time.time(), "exit_code": None,
                    "reason": "Previous Worker ownership was lost; process state is unknown. Command was not restarted.",
                    "event_id": f"{task_id}:1"}
                self._write(path, session_id, index, record)
                records[task_id] = record
        return records

    def _transaction(self, session_id: str, action: str, task_id: str | None = None, changes: dict | None = None, create: bool = False):
        directory = resolve_session_base(self.root, session_id)
        path = directory / "tasks.jsonl"
        if action in {"all", "relevant", "get", "maintain"} and not path.exists():
            return {} if action in {"all", "relevant"} else None
        directory.mkdir(parents=True, exist_ok=True)
        with self._lock, FileLock(str(path) + ".lock"):
            self._ensure_lease()
            index = self._sessions.get(session_id)
            if index is None:
                if len(self._sessions) >= self.SESSION_CACHE_LIMIT:
                    old, _ = self._sessions.popitem(last=False)
                    for key in [k for k in self._tasks if k[0] == old]:
                        self._tasks.pop(key)
                index = _SessionIndex()
                self._sessions[session_id] = index
            self._sessions.move_to_end(session_id)
            if path.exists():
                self._scan(path, session_id, index)
            elif index.identity is not None:
                for key in [k for k in self._tasks if k[0] == session_id]:
                    self._tasks.pop(key)
                index = self._sessions[session_id] = _SessionIndex()
            if action == "all":
                return self._recover(path, session_id, index, self._all(path))
            if action == "get":
                record = self._cached(path, session_id, task_id)
                return self._recover(path, session_id, index, {task_id: record})[task_id] if record else None
            if action == "relevant":
                if not index.relevant_complete:
                    records = self._scan_relevant(path, session_id, index)
                else:
                    records = {key[1]: dict(record) for key, (_, record) in self._tasks.items()
                               if key[0] == session_id and self._relevant(record)}
                # Recovery must preserve persisted output when it appends a terminal snapshot.
                for key, record in list(records.items()):
                    if record.get("status") not in TERMINAL_STATES and record.get("worker_instance_id") != self.worker_instance_id:
                        records[key] = self._cached(path, session_id, key)
                return {k: self._summary(v) for k, v in self._recover(path, session_id, index, records).items()}
            if action == "maintain":
                self._maintain(path, directory, index)
                return None
            if create:
                origin = changes.get("origin_tool_call_id")
                possible = origin and index.origins & (1 << self._origin_bit(origin))
                cached = next((r for (sid, _), (_, r) in self._tasks.items()
                               if sid == session_id and origin and r.get("origin_tool_call_id") == origin), None)
                existing = self._cached(path, session_id, cached["task_id"]) if cached else (
                    self._find(path, session_id, origin=origin) if possible and path.exists() else None)
                if existing is not None:
                    return self._recover(path, session_id, index, {existing["task_id"]: existing})[existing["task_id"]]
            previous = self._cached(path, session_id, task_id) if path.exists() and not create else None
            if previous is None and not changes.get("task_id"):
                raise LookupError(f"Unknown task: {task_id}")
            record = {**(previous or {}), **changes}
            record["handoff"] = bool(record.get("handoff") or (previous or {}).get("handoff"))
            self._write(path, session_id, index, record)
            return dict(record)

    def _maintain(self, path: Path, directory: Path, index: _SessionIndex) -> None:
        if index.maintained_at is not None and time.time() - index.maintained_at < self.MAINTENANCE_INTERVAL:
            return
        records = self._all(path)
        expired = [r for r in records.values() if r.get("finished_at") and r["finished_at"] < time.time() - 86400
                   and (r.get("consumed") or r.get("notify") == "manual" or r.get("status") == "cancelled") and "stdout" in r]
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
            index.identity = None
        index.maintained_at = time.time()

    @staticmethod
    def _append(path: Path, record: dict) -> None:
        with path.open("ab") as target:
            target.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            target.flush()
            os.fsync(target.fileno())

    async def close(self) -> None:
        self.close_now()

    def close_now(self) -> None:
        with self._lock:
            if self._lease is not None:
                self._lease.release()
                self._lease = None
            self._sessions.clear()
            self._tasks.clear()
