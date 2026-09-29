"""Score validated Windows L3 scenario summaries using the frozen plan budgets.

Usage: python test/score_load.py report.json
Missing scenarios, UI evidence, metrics or experience gates never receive zero
cost or a renormalized score. Raw trial data remains a separate required artifact.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import sys


# weight, CPU G/B, memory p95 MiB G/B, output KiB(/s) G/B
BUDGETS = (
    (8, (300, 3000), (250, 750), (32, 256)),
    (8, (.2, 2), (250, 750), (0, 16)),
    (8, (.3, 3), (350, 1000), (0, 16)),
    (8, (1, 10), (250, 750), (2, 32)),
    (16, (5, 30), (300, 900), (16, 128)),
    (12, (6, 40), (350, 1000), (24, 192)),
    (12, (8, 50), (400, 1200), (32, 256)),
    (12, (8, 50), (400, 1200), (16, 128)),
    (8, (8, 50), (400, 1200), (64, 512)),
    (8, (10, 60), (400, 1200), (64, 512)),
)


def score(value, good, bad):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Measurements must be finite, nonnegative numbers.")
    return 100 * max(0, min(1, (bad - value) / (bad - good)))


def score_report(report):
    manifest = report["manifest"]
    if report["level"] != "L3" or manifest["os"] != "windows":
        raise ValueError("These budgets require Windows L3 interactive UI results.")
    for name in ("interactive", "tty", "visible", "foreground", "ui_verified"):
        if manifest[name] is not True:
            raise ValueError(f"Invalid UI qualification: {name}.")
    for name in ("product_sha", "command", "terminal", "fixture_sha256", "ui_evidence", "raw_samples"):
        if not manifest[name]:
            raise ValueError(f"Missing evidence: {name}.")
    if report["correctness_passed"] is not True:
        raise ValueError("Correctness gates failed; publish raw measurements without a score.")
    expected = {f"C{index:02}" for index in range(1, 11)}
    if set(report["scenarios"]) != expected:
        raise ValueError("All ten public scenarios are required; coverage cannot be renormalized.")
    scores = {}
    for index, (_, cpu, memory, output) in enumerate(BUDGETS, 1):
        name = f"C{index:02}"
        data = report["scenarios"][name]
        for value in data.values():
            score(value, 0, 1)
        if not isinstance(data["trials"], int):
            raise ValueError(f"Trial count must be an integer: {name}.")
        if data["trials"] < (30 if index == 1 else 5):
            raise ValueError(f"Insufficient repetitions: {name}.")
        cpu_value = data["cpu_ms"] if index == 1 else data["cpu_core_percent"]
        output_value = data["output_bytes"] if index == 1 else data["output_bytes_per_second"]
        memory_score = .6 * score(data["private_bytes_p95"] / 1048576, *memory)
        memory_score += .4 * score(data["private_bytes_peak"] / 1048576, *(value * 1.25 for value in memory))
        if data["private_bytes_peak"] < data["private_bytes_p95"]:
            raise ValueError(f"Memory peak is smaller than p95: {name}.")
        if index == 1:
            response = score(data["first_input_ms"], 400, 2000)
        else:
            response = score(data["input_p95_ms"], 20, 100)
            if data["input_p99_ms"] < data["input_p95_ms"]:
                raise ValueError(f"Input p99 is smaller than p95: {name}.")
            if data["input_p95_ms"] > 50 or data["input_p99_ms"] > 100:
                raise ValueError(f"Input responsiveness gate failed: {name}.")
            if index in (5, 6, 7, 8, 9):
                response = (response + score(data["stream_p95_ms"], 50, 150)) / 2
                if data["stream_p95_ms"] > 100 or data["tail_ms"] > 150:
                    raise ValueError(f"Streaming responsiveness gate failed: {name}.")
            if index in (4, 5, 6, 7, 8, 9):
                if data["cancel_p95_ms"] > 150:
                    raise ValueError(f"Cancellation responsiveness gate failed: {name}.")
        scores[name] = .4 * score(cpu_value, *cpu) + .3 * memory_score
        scores[name] += .1 * score(output_value / 1024, *output) + .2 * response
    return {"scenario_scores": scores,
            "total": sum(scores[f"C{index:02}"] * budget[0] for index, budget in enumerate(BUDGETS, 1)) / 100}


if __name__ == "__main__":
    try:
        print(json.dumps(score_report(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))), indent=2))
    except (IndexError, KeyError, ValueError, TypeError) as error:
        raise SystemExit(f"Unscored: {error}") from error
