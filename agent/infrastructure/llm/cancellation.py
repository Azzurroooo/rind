"""Await a provider coroutine while staying responsive to cancellation."""

from __future__ import annotations

import asyncio
import inspect

from agent.domain.cancellation import CancellationToken


async def await_with_cancellation(awaitable, cancellation_token: CancellationToken | None):
    if cancellation_token is None:
        return await awaitable
    task = asyncio.create_task(awaitable)
    cancel = asyncio.create_task(cancellation_token.wait())
    try:
        done, _ = await asyncio.wait((task, cancel), return_when=asyncio.FIRST_COMPLETED)
        if cancel in done:
            raise asyncio.CancelledError(cancellation_token.reason)
        return task.result()
    finally:
        for pending in (task, cancel):
            if not pending.done():
                pending.cancel()
        await asyncio.gather(task, cancel, return_exceptions=True)


async def close_resource(resource) -> None:
    close = getattr(resource, "aclose", None) or getattr(resource, "close", None)
    if callable(close):
        result = close()
        if inspect.isawaitable(result):
            await result
