"""Worker-owned serialization for edits and writes to the same file."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import os

from agent.domain import tool_cancelled
from agent.domain.cancellation import CancellationToken


class FileMutationQueue:
    def __init__(self, semaphore: asyncio.Semaphore | None = None) -> None:
        self._locks: dict[str, tuple[asyncio.Lock, int]] = {}
        self._semaphore = semaphore

    async def run(
        self,
        path: str,
        operation: Callable[[], str],
        *,
        tool_name: str,
        cancellation_token: CancellationToken | None = None,
    ) -> str:
        key = os.path.normcase(os.path.realpath(path))
        if key not in self._locks:
            self._locks[key] = (asyncio.Lock(), 0)
        lock, users = self._locks[key]
        self._locks[key] = (lock, users + 1)
        acquire = asyncio.create_task(lock.acquire())
        cancelled = asyncio.create_task(cancellation_token.wait()) if cancellation_token else None
        slot_acquire: asyncio.Task[bool] | None = None
        try:
            if cancelled is not None:
                await asyncio.wait((acquire, cancelled), return_when=asyncio.FIRST_COMPLETED)
                if cancellation_token.is_cancelled:
                    return tool_cancelled(tool_name, cancellation_token.reason)
            else:
                await asyncio.shield(acquire)

            if self._semaphore is not None:
                slot_acquire = asyncio.create_task(self._semaphore.acquire())
                if cancelled is not None:
                    await asyncio.wait((slot_acquire, cancelled), return_when=asyncio.FIRST_COMPLETED)
                    if cancellation_token.is_cancelled:
                        return tool_cancelled(tool_name, cancellation_token.reason)
                else:
                    await asyncio.shield(slot_acquire)

            work = asyncio.create_task(asyncio.to_thread(operation))
            try:
                return await asyncio.shield(work)
            finally:
                # Cancelling the await cannot stop a filesystem thread. Keep ownership until it settles.
                while not work.done():
                    try:
                        await asyncio.shield(work)
                    except asyncio.CancelledError:
                        continue
        finally:
            waiters = [acquire] + ([slot_acquire] if slot_acquire is not None else []) + ([cancelled] if cancelled is not None else [])
            for waiter in waiters:
                waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
            if slot_acquire is not None and not slot_acquire.cancelled() and slot_acquire.result():
                self._semaphore.release()
            if not acquire.cancelled() and acquire.result():
                lock.release()
            _, users = self._locks[key]
            if users == 1:
                del self._locks[key]
            else:
                self._locks[key] = (lock, users - 1)
