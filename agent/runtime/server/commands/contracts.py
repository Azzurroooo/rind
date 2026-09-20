"""Shared slash-command contracts, independent of dispatch and handlers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable


@dataclass(slots=True)
class SlashCommandContext:
    runtime: Any
    session: Any
    debug: bool = False
    workspace_root: str | None = None
    compact_context: Callable[[], Awaitable[dict]] | None = None


@dataclass(slots=True)
class SlashCommandResult:
    text: str = ""
    display: dict[str, Any] | None = None
    prompt_prefill: str = ""
    next_prompt: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"text": self.text}
        if self.display is not None:
            result["display"] = self.display
        if self.prompt_prefill:
            result["prompt_prefill"] = self.prompt_prefill
        if self.next_prompt is not None:
            result["next_prompt"] = self.next_prompt
        return result


Handler = Callable[
    [SlashCommandContext, list[str]],
    str | SlashCommandResult | Awaitable[str | SlashCommandResult],
]

@dataclass(frozen=True, slots=True)
class SlashCommandInfo:
    name: str
    description: str
    usage: str = ""
    aliases: tuple[str, ...] = ()
    handler: Handler | None = None


