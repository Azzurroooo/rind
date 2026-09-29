from contextlib import nullcontext
from types import SimpleNamespace

import psutil
import pytest

from bench_processes import sample


class Process:
    def __init__(self, pid, created=1):
        self.pid = pid
        self.created = created
        self.alive = True
        self.descendants = []

    def is_running(self):
        return self.alive

    def children(self, recursive):
        assert recursive
        return self.descendants

    def create_time(self):
        return self.created

    def oneshot(self):
        return nullcontext()

    def cpu_times(self):
        return SimpleNamespace(user=2, system=3)

    def memory_info(self):
        return SimpleNamespace(private=4096, rss=8192)

    def ppid(self):
        return 0

    def name(self):
        return "test"


def test_provider_root_does_not_double_count_agent_tree():
    provider, agent, worker = Process(1), Process(2), Process(3)
    provider.descendants = [agent, worker]
    agent.descendants = [worker]
    record = sample({"provider": (provider, False), "agent": (agent, True)}, {})
    assert [(p["role"], p["pid"]) for p in record["processes"]] == [
        ("provider", 1), ("agent", 2), ("agent", 3)]
    assert record["processes"][0]["private_bytes"] == 4096
    assert record["processes"][0]["cpu_seconds"] == 5


def test_overlapping_trees_fail_instead_of_reporting_a_false_total():
    parent, child = Process(1), Process(2)
    parent.descendants = [child]
    with pytest.raises(ValueError, match="Overlapping roots"):
        sample({"a": (parent, True), "b": (child, True)}, {})


def test_orphan_remains_observed_and_pid_reuse_is_a_new_identity():
    root, child = Process(1), Process(2)
    root.descendants = [child]
    roots, known = {"agent": (root, True)}, {}
    sample(roots, known)
    root.alive = False
    record = sample(roots, known)
    assert [p["pid"] for p in record["processes"]] == [2]
    assert record["errors"][0]["error"] == "NoSuchProcess"
    child.alive = False
    replacement = Process(2, created=9)
    record = sample({"new": (replacement, False)}, known)
    assert [(p["pid"], p["created_at"]) for p in record["processes"]] == [(2, 9)]
    assert record["errors"][0]["created_at"] == 1


def test_read_failure_is_explicit(monkeypatch):
    root = Process(1)
    def denied():
        raise psutil.AccessDenied(root.pid)
    monkeypatch.setattr(root, "memory_info", denied)
    record = sample({"agent": (root, False)}, {})
    assert not record["processes"]
    assert record["errors"][0]["error"] == "AccessDenied"
