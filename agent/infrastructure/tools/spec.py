"""Immutable specification for a registered tool."""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Any, Callable

from .schema import build_function_schema


_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True, slots=True, init=False)
class ToolSpec:
    """Bind one tool handler to its model schema and invocation metadata."""

    name: str
    handler: Callable[..., Any]
    schema: dict[str, Any]
    is_async: bool
    accepted_arguments: frozenset[str] | None

    def __init__(
        self,
        *,
        name: str,
        handler: Callable[..., Any],
        description: str,
        param_descriptions: dict[str, str | dict[str, Any]] | None = None,
    ) -> None:
        if not isinstance(name, str) or not _TOOL_NAME_PATTERN.fullmatch(name):
            raise ValueError(f"Invalid tool name: {name!r}")
        if not callable(handler):
            raise TypeError("Tool handler must be callable.")

        signature = inspect.signature(handler)
        accepts_kwargs = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in signature.parameters.values()
        )
        accepted_arguments = None if accepts_kwargs else frozenset(signature.parameters)

        object.__setattr__(self, "name", name)
        object.__setattr__(self, "handler", handler)
        object.__setattr__(
            self,
            "schema",
            build_function_schema(
                name=name,
                func=handler,
                description=description,
                param_descriptions=param_descriptions,
            ),
        )
        object.__setattr__(self, "is_async", inspect.iscoroutinefunction(handler))
        object.__setattr__(self, "accepted_arguments", accepted_arguments)
