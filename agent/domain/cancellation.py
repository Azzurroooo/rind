"""Cancellation protocol for runtime operations."""

from __future__ import annotations

import asyncio
import logging
from typing import Callable


logger = logging.getLogger(__name__)


class CancellationToken:
    """
    A token that can be checked by operations to determine if they should be cancelled.
    """
    def __init__(self) -> None:
        self._is_cancelled = False
        self._reason: str | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._async_event: asyncio.Event | None = None

    @property
    def is_cancelled(self) -> bool:
        return self._is_cancelled

    @property
    def reason(self) -> str | None:
        return self._reason

    def register_callback(self, callback: Callable[[], None]) -> Callable[[], None]:
        """
        Register a callback to be invoked immediately when cancelled.
        Returns a deregister function.
        """
        if self._is_cancelled:
            callback()
            return lambda: None

        self._callbacks.append(callback)

        def deregister():
            if callback in self._callbacks:
                self._callbacks.remove(callback)

        return deregister

    async def wait(self) -> None:
        """Asynchronously wait until the token is cancelled."""
        if self._is_cancelled:
            return

        if self._async_event is None:
            # Create the event lazily in the current running loop
            self._async_event = asyncio.Event()
            if self._is_cancelled:
                self._async_event.set()

        await self._async_event.wait()

    def _cancel(self, reason: str | None = None) -> None:
        """Internal method to trigger cancellation."""
        if self._is_cancelled:
            return

        self._is_cancelled = True
        self._reason = reason

        if self._async_event is not None:
            self._async_event.set()

        callbacks = list(self._callbacks)
        self._callbacks.clear()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                logger.debug("Cancellation callback failed.", exc_info=True)


class CancellationTokenSource:
    """
    The source that controls a CancellationToken and can trigger cancellation.
    """
    def __init__(self, parent_token: CancellationToken | None = None) -> None:
        self.token = CancellationToken()
        self._parent_deregister = None

        if parent_token:
            self._parent_deregister = parent_token.register_callback(
                lambda: self.cancel(reason=parent_token.reason)
            )

    def cancel(self, reason: str | None = None) -> None:
        """Trigger cancellation on the associated token and all its children."""
        self.token._cancel(reason)

    def dispose(self) -> None:
        """Clean up parent listeners to prevent memory leaks."""
        if self._parent_deregister:
            self._parent_deregister()
            self._parent_deregister = None


def create_child_token(parent: CancellationToken) -> CancellationTokenSource:
    """
    Create a new cancellation token source linked to a parent token.
    If the parent token is cancelled, the child token will also be cancelled.
    """
    return CancellationTokenSource(parent_token=parent)
