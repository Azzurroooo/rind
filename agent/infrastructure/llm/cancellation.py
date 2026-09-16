"""Await a provider coroutine while staying responsive to cancellation."""

from __future__ import annotations

import asyncio

from agent.domain.cancellation import CancellationToken


async def await_with_cancellation(awaitable, cancellation_token: CancellationToken | None):
    if cancellation_token is None:
        return await awaitable
    task = asyncio.create_task(awaitable)
    cancel = asyncio.create_task(cancellation_token.wait())
    done, _ = await asyncio.wait((task, cancel), return_when=asyncio.FIRST_COMPLETED)
    if cancel in done:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise asyncio.CancelledError(cancellation_token.reason)
    cancel.cancel()
    await asyncio.gather(cancel, return_exceptions=True)
    return task.result()
