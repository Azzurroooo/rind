"""Shared managed-process states and public task snapshots."""

TERMINAL_STATES = frozenset({"completed", "failed", "cancelled", "timed_out", "lost"})


def public_task(record: dict) -> dict:
    result = {key: value for key, value in record.items()
              if key not in {"committed", "delivered", "consumed", "worker_instance_id", "pid", "event_id", "type"}}
    result["handoff"] = bool(record.get("handoff"))
    return result
