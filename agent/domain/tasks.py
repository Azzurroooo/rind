"""Shared managed-process states and public task snapshots."""

TERMINAL_STATES = frozenset({"completed", "failed", "cancelled", "timed_out", "lost"})


def public_task(record: dict) -> dict:
    return {key: value for key, value in record.items()
            if key not in {"committed", "handoff", "delivered", "consumed", "worker_instance_id", "pid", "event_id", "type"}}
