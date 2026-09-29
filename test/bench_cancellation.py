"""L1 diagnostic: stream cancellation CPU/profile, never public scoring."""
import asyncio
import cProfile
import io
import json
import pstats
import statistics
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.domain.cancellation import CancellationToken
from agent.infrastructure.llm.cancellation import iterate_with_cancellation


async def source():
    for i in range(10000):
        await asyncio.sleep(0)
        yield i


async def trial():
    start = time.process_time()
    count = 0
    async for _ in iterate_with_cancellation(source(), CancellationToken()):
        count += 1
    assert count == 10000
    return (time.process_time() - start) * 1000


async def main():
    samples = [await trial() for _ in range(5)]
    profiler = cProfile.Profile()
    profiler.enable()
    await trial()
    profiler.disable()
    output = io.StringIO()
    pstats.Stats(profiler, stream=output).strip_dirs().sort_stats("tottime").print_stats(18)
    print(json.dumps({"level": "L1", "publicScoreEligible": False,
                      "cpuMs": samples, "medianCpuMs": statistics.median(samples),
                      "profile": output.getvalue()}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
