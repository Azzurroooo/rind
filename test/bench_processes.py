"""Sample explicit process roots for diagnosis, not certified L3 scoring.

Example: python test/bench_processes.py --tree agent:1234 --seconds 60 --output samples.jsonl
Polling cannot account for children which start and exit between samples.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

import psutil


def read_process(process: psutil.Process) -> dict:
    with process.oneshot():
        cpu = process.cpu_times()
        memory = process.memory_info()
        return {
            "pid": process.pid, "created_at": process.create_time(),
            "parent_pid": process.ppid(), "name": process.name(),
            "cpu_seconds": cpu.user + cpu.system,
            "private_bytes": memory.private, "working_set_bytes": memory.rss,
        }


def sample(roots: dict[str, tuple[psutil.Process, bool]], known: dict) -> dict:
    started = time.perf_counter()
    errors = []
    for role, (root, include_children) in roots.items():
        try:
            descendants = root.children(recursive=True) if include_children and root.is_running() else []
            for process in [root, *descendants]:
                identity = (process.pid, process.create_time())
                owner = known.get(identity)
                if owner and owner[0] != role:
                    raise ValueError(f"Overlapping roots: PID {process.pid} belongs to {owner[0]} and {role}")
                known[identity] = (role, process)
        except psutil.Error as error:
            errors.append({"role": role, "pid": root.pid, "error": type(error).__name__})
    records = []
    for identity, (role, process) in list(known.items()):
        try:
            if not process.is_running():
                raise psutil.NoSuchProcess(process.pid)
            records.append({"role": role, **read_process(process)})
        except psutil.Error as error:
            errors.append({"role": role, "pid": process.pid, "created_at": identity[1],
                           "error": type(error).__name__})
            del known[identity]
    return {"monotonic_seconds": started, "read_seconds": time.perf_counter() - started,
            "processes": records, "errors": errors}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", action="append", default=[], metavar="ROLE:PID", help="One process only")
    parser.add_argument("--tree", action="append", default=[], metavar="ROLE:PID", help="Process and descendants")
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("This sampler uses Windows Private Bytes; other OS metrics must be implemented explicitly.")
    if not 0 < args.seconds <= 7200:
        parser.error("--seconds must be positive and at most 7200")
    if not args.root and not args.tree:
        parser.error("Specify at least one --root or --tree")
    roots = {}
    for value, include_children in [(value, False) for value in args.root] + [(value, True) for value in args.tree]:
        role, separator, pid = value.partition(":")
        if not separator or not role or not pid.isdigit() or role in roots or role == "sampler":
            parser.error("Each root needs a unique ROLE:PID; sampler is reserved.")
        roots[role] = (psutil.Process(int(pid)), include_children)
    roots["sampler"] = (psutil.Process(os.getpid()), False)
    known = {}
    with args.output.open("x", encoding="utf-8") as output:
        output.write(json.dumps({"type": "manifest", "public_score_eligible": False,
                                 "interval_seconds": 0.25, "platform": sys.platform,
                                 "python": sys.version, "psutil": psutil.__version__,
                                 "short_lived_processes_accounted": False,
                                 "note": "CPU is cumulative. Use differences over monotonic time. UI evidence is separate."}) + "\n")
        deadline = time.perf_counter() + args.seconds
        while True:
            record = sample(roots, known)
            output.write(json.dumps(record) + "\n")
            output.flush()
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            time.sleep(min(max(0, 0.25 - record["read_seconds"]), remaining))


if __name__ == "__main__":
    main()
