"""Default tool registry adapter."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .builtin import TOOL_SPECS
from .spec import ToolSpec


class DefaultToolRegistry:
    """Adapter to expose tool implementations/schemas to application layer."""

    def __init__(self, specs: Iterable[ToolSpec] | None = None):
        catalog = TOOL_SPECS if specs is None else tuple(specs)
        specs_by_name: dict[str, ToolSpec] = {}
        for spec in catalog:
            if not isinstance(spec, ToolSpec):
                raise TypeError("Tool catalog entries must be ToolSpec instances.")
            if spec.name in specs_by_name:
                raise ValueError(f"Duplicate tool name: {spec.name}")
            specs_by_name[spec.name] = spec
        self._specs_by_name = specs_by_name
        self._schemas = [spec.schema for spec in catalog]

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
        return spec.handler(**self._filter_call_args(spec, args))

    async def call_async(self, name: str, args: dict) -> Any:
        spec = self._specs_by_name[name]
        return await spec.handler(**self._filter_call_args(spec, args))

    def _filter_call_args(self, spec: ToolSpec, args: dict) -> dict:
        if spec.accepted_arguments is None:
            return args
        return {key: value for key, value in args.items() if key in spec.accepted_arguments}
