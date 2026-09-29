"""Synthetic JSONL hot-path benchmark; no model or terminal UI is involved."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.infrastructure.persistence.task_journal import TaskJournal
from agent.infrastructure.tools.shell.capture import StreamCapture
from agent.infrastructure.tools.shell.supervisor import ProcessSupervisor


def memory_bytes() -> int:
    info = psutil.Process().memory_info()
    return getattr(info, "private", info.rss)


async def measure(operation, journal: TaskJournal, scans: dict) -> dict:
    walls, cpus = [], []
    for _ in range(3):
        wall_start, cpu_start = time.perf_counter(), time.process_time()
        for _ in range(100):
            await operation()
        walls.append((time.perf_counter() - wall_start) * 1000)
        cpus.append((time.process_time() - cpu_start) * 1000)
    return {"wall_ms_per_100": round(statistics.median(walls), 2),
            "cpu_ms_per_100": round(statistics.median(cpus), 2),
            "history_fallback_scans": sum(scans.values()),
            "private_bytes": memory_bytes(), "task_cache": len(journal._tasks),
            "session_cache": len(journal._sessions)}


async def sample(root: Path, count: int) -> dict:
    directory = root / f"session-{count}"
    directory.mkdir()
    path = directory / "tasks.jsonl"
    with path.open("w", encoding="utf-8") as output:
        for index in range(count):
            output.write(json.dumps({"task_id": f"task_{index}", "status": "completed",
                "delivered": True, "consumed": True, "handoff": True,
                "stdout": "x" * 1000}) + "\n")
    journal = TaskJournal(root)
    supervisor = ProcessSupervisor(journal=journal)
    session_id = directory.name
    try:
        await journal.relevant(session_id)
        await journal.save(session_id, {"task_id": "active", "status": "running",
            "started_at": time.time(), "worker_instance_id": journal.worker_instance_id}, create=True)
        scans = {"count": 0}
        for name in ("_find", "_scan_relevant", "_all"):
            original = getattr(journal, name)

            def counted(*args, _original=original, **kwargs):
                scans["count"] += 1
                return _original(*args, **kwargs)

            setattr(journal, name, counted)

        async def idle():
            await journal.relevant(session_id)

        async def turn():
            await journal.get(session_id, "active")
            await journal.update(session_id, "active", committed=True)

        capture = StreamCapture()

        async def output():
            capture.append(b"x" * 16384, "x" * 16384)
            capture.tail_preview(2000)
            await journal.relevant(session_id)

        async def monitor():
            await supervisor.monitor_tasks(session_id)

        scenarios = {}
        for name, operation in (("idle", idle), ("turn", turn),
                                ("background_output", output), ("monitor_list", monitor)):
            scans["count"] = 0
            scenarios[name] = await measure(operation, journal, scans)
        return {"completed_tasks": count, "jsonl_bytes": path.stat().st_size,
                "scenarios": scenarios}
    finally:
        await journal.close()


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="rind-task-bench-") as temporary:
        results = [await sample(Path(temporary), count) for count in (0, 1000, 10000)]
    print(json.dumps({"level": "L1", "scope": "Python components; no subprocess or terminal UI",
        "public_score_eligible": False, "samples": results}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
