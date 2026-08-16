"""Asynchronous interface for session persistence."""

from __future__ import annotations

from typing import Protocol, Any


class SessionStore(Protocol):
    """Protocol for asynchronously persisting session state and history."""

    @property
    def session_id(self) -> str | None:
        ...

    @property
    def model(self) -> str | None:
        ...

    @property
    def system_prompt(self) -> str:
        ...

    @property
    def session_root(self) -> str:
        """Return the canonical root used to persist sessions."""
        ...

    @property
    def session_base_path(self) -> str | None:
        """Return the active session directory when a session is bound."""
        ...

    def now_iso(self) -> str:
        ...

    async def initialize(self) -> None:
        """Initialize or load the session state."""
        ...

    async def discard_if_empty(self) -> None:
        """Remove the active session when it has no conversation messages."""
        ...

    async def switch_session(self, session_id: str) -> dict[str, Any]:
        """Switch this store instance to an existing session."""
        ...

    async def create_session(self) -> dict[str, Any]:
        """Create and bind a new session."""
        ...

    async def update_model(self, model: str) -> None:
        """Update the model recorded for the active session."""
        ...

    async def get_skill_catalog(self) -> list[dict[str, str]]:
        """Return the persisted effective Skill metadata catalog."""
        ...

    async def set_skill_catalog(self, entries: list[dict[str, str]]) -> None:
        """Persist the effective Skill metadata catalog without changing activity timestamps."""
        ...

    async def persist_message(
        self,
        role: str,
        content: str,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        meta: dict[str, Any] | None = None,
        reasoning_content: str | None = None,
    ) -> None:
        """Persist a single chat message asynchronously."""
        ...

    async def persist_tool_call(
        self,
        call_id: str,
        name: str,
        parsed_args: dict,
        raw_args: str,
        ts_start: str,
        ts_end: str,
        result_payload: str,
        model_content: str,
        model_content_format: str | None = None,
        model_content_policy: dict[str, Any] | None = None,
    ) -> None:
        """Persist tool call execution details asynchronously."""
        ...

    async def load_messages(self) -> list[dict[str, Any]]:
        """Load all raw messages asynchronously."""
        ...

    async def list_recent_sessions(self, limit: int = 10) -> list[dict[str, Any]]:
        """List recently updated sessions asynchronously."""
        ...

    async def get_messages_slice(
        self,
        start: int | None = None,
        end: int | None = None,
        roles: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Get a slice of messages asynchronously."""
        ...

    async def get_tool_records(self, limit: int | None = None, call_ids: list[str] | None = None) -> list[dict[str, Any]]:
        """Get tool records asynchronously."""
        ...

    async def persist_compaction(self, compaction: dict[str, Any]) -> dict[str, Any]:
        """Persist a compact boundary and matching compaction record."""
        ...

    async def get_latest_compaction(self) -> dict[str, Any] | None:
        """Get the latest compact boundary record."""
        ...


    async def persist_sampling_usage(self, usage: dict[str, Any]) -> None:
        """Persist latest provider token usage for observability."""
        ...

    async def get_latest_sampling_usage(self) -> dict[str, Any] | None:
        """Get the latest provider token usage sample."""
        ...

    async def get_latest_assistant_sampling_usage(self) -> dict[str, Any] | None:
        """Get the latest ordinary assistant sampling usage sample."""
        ...

    async def persist_turn_state(self, turn_id: str, status: str, ts: str) -> None:
        """Persist the latest turn state."""
        ...

    async def get_turn_state(self) -> dict[str, Any] | None:
        """Get the latest persisted turn state."""
        ...

    async def get_goal(self) -> dict[str, str] | None:
        """Get the active session goal, if one exists."""
        ...

    async def set_goal(self, objective: str) -> dict[str, str]:
        """Create or replace the active session goal."""
        ...

    async def set_goal_status(self, status: str) -> dict[str, str]:
        """Update an existing session goal status."""
        ...

    async def clear_goal(self) -> None:
        """Remove the active session goal."""
        ...

    async def get_compact_generation(self) -> int:
        """Get the current compact generation counter."""
        ...
