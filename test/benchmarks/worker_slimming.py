"""Synthetic benchmarks: python worker_slimming.py <source-checkout>."""

import asyncio
import hashlib
import json
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

from agent.application.context import ContextEstimator, ContextManager
from agent.application.context.estimator import ContextBudget
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore


def digest(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_history(base, size, with_tools):
    messages = [
        {"id": str(i), "role": "user" if i % 2 else "assistant",
         "content": "Sample message 中文 " * 20, "ts": "2026-09-17"}
        for i in range(size)
    ]
    records = []
    if with_tools:
        for i in range(0, size, 10):
            call_id = f"tool-{i}"
            messages[i] = {
                "id": str(i), "role": "assistant", "content": "",
                "meta": {"tool_calls": [{"id": call_id, "name": "read_file"}]},
            }
            messages[i + 1] = {"id": str(i + 1), "role": "tool", "tool_call_id": call_id, "content": ""}
            output = "sample output " * 600
            records.append({
                "id": call_id, "name": "read_file", "args": {"path": "sample.txt"},
                "raw_args": '{"path":"sample.txt"}', "result": output, "model_content": output,
            })
    messages.insert(0, {"id": "system", "role": "system", "content": "system", "ts": "2026-09-17"})
    for name, rows in (("messages", messages), ("tool_calls", records)):
        (base / f"{name}.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8",
        )
    return len(records)


async def measure_session(size, with_tools):
    with tempfile.TemporaryDirectory() as directory:
        def open_store():
            return JsonlSessionStore(session_dir=directory, session_id="benchmark", system_prompt="system")

        store = open_store()
        await store.initialize()
        count = write_history(Path(store.session_base_path), size, with_tools)
        loads, projections = [], []
        for _ in range(21):
            fresh = open_store()
            start = time.perf_counter()
            await fresh.initialize()
            loads.append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            projected = await fresh.get_messages_slice()
            projections.append((time.perf_counter() - start) * 1000)
        fresh = open_store()
        tracemalloc.start()
        await fresh.initialize()
        await fresh.get_messages_slice()
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        return {
            "load_p50_ms": statistics.median(loads[1:]),
            "load_p95_ms": sorted(loads[1:])[18],
            "projection_p50_ms": statistics.median(projections[1:]),
            "projection_p95_ms": sorted(projections[1:])[18],
            "peak_mib": peak / 1024**2,
            "projection_sha256": digest(projected),
            "tool_records": count,
        }


async def measure_rescue():
    class Session:
        async def get_messages_slice(self, **kwargs):
            return [{"role": "system", "content": "system"}] + [
                {"role": "user" if i % 2 else "assistant",
                 "content": ("Code 示例 + verbose output " * 100) + str(i)}
                for i in range(100)
            ]

    estimator = ContextEstimator(ContextBudget(hard_limit_tokens=500))
    assert estimator._tokenizer is not None, "Tokenization must not silently fall back during benchmarks"
    manager = ContextManager(estimator=estimator)
    elapsed = []
    for _ in range(6):
        start = time.perf_counter()
        result = await manager.build_messages_async(Session(), allow_rescue=True, include_skill_catalog=False)
        elapsed.append((time.perf_counter() - start) * 1000)
    return {
        "p50_ms": statistics.median(elapsed[1:]),
        "samples_ms": elapsed[1:],
        "tokens": result.stats["estimated_input_tokens"],
        "messages_sha256": digest(result.messages),
    }


async def main():
    results = {}
    for size, with_tools in ((1000, False), (10000, False), (10000, True)):
        key = str(size) + ("_with_tools" if with_tools else "")
        results[key] = await measure_session(size, with_tools)
    results["context_rescue"] = await measure_rescue()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
