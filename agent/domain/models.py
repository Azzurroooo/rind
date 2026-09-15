"""Provider-neutral model and credential values."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .tool_payload import ParsedToolCall


@dataclass(frozen=True, slots=True)
class ModelSelection:
    provider_id: str
    model_id: str
    reasoning_effort: str = ""


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    provider_id: str
    id: str
    name: str
    api: str
    reasoning_efforts: tuple[str, ...] = ()
    context_window: int | None = None


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    id: str
    name: str
    api: str
    default_base_url: str
    auth_methods: tuple[str, ...] = ("api_key",)
    environment_key: str = ""
    fallback_models: tuple[ModelDefinition, ...] = ()


@dataclass(frozen=True, slots=True)
class ProviderStatus:
    id: str
    name: str
    methods: tuple[str, ...]
    configured: bool
    source: Literal["workspace", "stored", "environment", "none"]


@dataclass(frozen=True, slots=True)
class Credential:
    type: Literal["api_key", "oauth"]
    key: str = ""
    access: str = ""
    refresh: str = ""
    expires_at: int | None = None


@dataclass(frozen=True, slots=True)
class ModelUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    reasoning_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


ModelStreamKind = Literal[
    "text_delta",
    "reasoning_delta",
    "tool_start",
    "tool_arguments_delta",
    "tool_end",
    "usage",
    "completed",
]
StopReason = Literal["stop", "tool_calls", "length", "content_filter", "error"]


@dataclass(frozen=True, slots=True)
class ModelStreamEvent:
    kind: ModelStreamKind
    text: str = ""
    reasoning: str = ""
    tool_call_id: str = ""
    tool_name: str = ""
    arguments: str = ""
    usage: ModelUsage | None = None
    stop_reason: StopReason | None = None


@dataclass(frozen=True, slots=True)
class ModelCompletion:
    content: str = ""
    tool_calls: tuple[ParsedToolCall, ...] = ()
    reasoning_content: str | None = None
    usage: ModelUsage | None = None
    finish_reason: StopReason | None = None
