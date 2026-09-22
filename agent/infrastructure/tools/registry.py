"""Default tool registry adapter."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from agent.domain import tool_error

from .spec import ToolSpec


class DefaultToolRegistry:
    """Adapter to expose tool implementations/schemas to application layer."""

    def __init__(self, specs: Iterable[ToolSpec]):
        catalog = tuple(specs)
        specs_by_name: dict[str, ToolSpec] = {}
        for spec in catalog:
            if not isinstance(spec, ToolSpec):
                raise TypeError("Tool catalog entries must be ToolSpec instances.")
            if spec.name in specs_by_name:
                raise ValueError(f"Duplicate tool name: {spec.name}")
            specs_by_name[spec.name] = spec
        self._specs_by_name = specs_by_name
        self._schemas = [spec.schema for spec in catalog if spec.advertised]

    @property
    def schemas(self) -> list[dict]:
        return self._schemas

    def has(self, name: str) -> bool:
        return name in self._specs_by_name

    def is_async(self, name: str) -> bool:
        spec = self._specs_by_name.get(name)
        return spec is not None and spec.is_async

    def call(self, name: str, args: dict) -> Any:
        spec = self._specs_by_name[name]
        prepared = self._prepare_call_args(spec, args)
        return prepared if isinstance(prepared, str) else spec.handler(**prepared)

    async def call_async(self, name: str, args: dict) -> Any:
        spec = self._specs_by_name[name]
        prepared = self._prepare_call_args(spec, args)
        return prepared if isinstance(prepared, str) else await spec.handler(**prepared)

    def _prepare_call_args(self, spec: ToolSpec, args: dict) -> dict | str:
        parameters = spec.schema["function"]["parameters"]
        allowed = sorted(parameters["properties"])
        try:
            args = spec.normalize_arguments(dict(args)) if spec.normalize_arguments else args
        except ValueError as exc:
            return tool_error(spec.name, str(exc), "InvalidArguments", meta={"allowed": allowed})
        missing = sorted(set(parameters["required"]) - args.keys())
        unknown = sorted(
            key for key in args if not key.startswith("_") and key not in allowed
        ) if spec.accepted_arguments is not None else []
        if missing or unknown:
            return tool_error(
                spec.name,
                f"Missing arguments: {', '.join(missing) or 'none'}. "
                f"Unknown arguments: {', '.join(unknown) or 'none'}. Allowed: {', '.join(allowed)}.",
                "InvalidArguments", meta={"missing": missing, "unknown": unknown, "allowed": allowed},
            )
        if spec.accepted_arguments is None:
            return args
        return {key: value for key, value in args.items() if key in spec.accepted_arguments}
