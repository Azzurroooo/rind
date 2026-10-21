"""Await a provider coroutine while staying responsive to cancellation and silence."""

from __future__ import annotations

import asyncio
import inspect

from agent.domain.cancellation import CancellationToken

# A request or stream that delivers nothing for this long has stalled: a
# connection kept open by keep-alives alone would otherwise hold the turn forever.
MODEL_IDLE_TIMEOUT_SECONDS = 600


async def _within_idle_timeout(awaitable):
    try:
        return await asyncio.wait_for(awaitable, MODEL_IDLE_TIMEOUT_SECONDS)
    except TimeoutError:
        raise TimeoutError(f"The model sent nothing for {MODEL_IDLE_TIMEOUT_SECONDS} seconds.") from None


async def await_with_cancellation(awaitable, cancellation_token: CancellationToken | None):
    if cancellation_token is None:
        return await _within_idle_timeout(awaitable)
    task = asyncio.create_task(_within_idle_timeout(awaitable))
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


async def iterate_with_cancellation(stream, cancellation_token: CancellationToken | None):
    iterator = aiter(stream)
    if cancellation_token is None:
        while True:
            try:
                item = await _within_idle_timeout(anext(iterator))
            except StopAsyncIteration:
                return
            yield item

    read_task = None

    def cancel_read():
        if read_task is not None:
            read_task.cancel(cancellation_token.reason)

    deregister = cancellation_token.register_callback(cancel_read)
    try:
        while True:
            if cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)
            read_task = asyncio.create_task(_within_idle_timeout(anext(iterator)))
            try:
                item = await read_task
            except StopAsyncIteration:
                if cancellation_token.is_cancelled:
                    raise asyncio.CancelledError(cancellation_token.reason)
                return
            finally:
                read_task = None
            if cancellation_token.is_cancelled:
                raise asyncio.CancelledError(cancellation_token.reason)
            yield item
    finally:
        deregister()
