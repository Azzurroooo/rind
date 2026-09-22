from __future__ import annotations

from typing import Protocol


class TaskStore(Protocol):
    async def records(self, session_id: str) -> dict[str, dict]: ...

    async def update(self, session_id: str, task_id: str, **changes) -> dict: ...
