"""Application boundary for provider selection, auth and model discovery."""

from __future__ import annotations

from typing import Protocol

from agent.domain.models import (
    ModelCatalog,
    ModelDefinition,
    ModelSelection,
    ProviderStatus,
)


class ProviderService(Protocol):
    def default_selection(self, workspace_root: str | None = None) -> ModelSelection: ...

    def resolve_selection(self, workspace_root: str | None, selection: ModelSelection) -> ModelDefinition: ...

    def list_providers(self, workspace_root: str | None = None) -> list[ProviderStatus]: ...

    async def list_models(self, workspace_root: str | None = None, *, refresh: bool = False) -> ModelCatalog: ...

    async def refresh_stale_models(self, workspace_root: str | None = None) -> None: ...

    async def login(self, workspace_root: str | None, provider_id: str, method: str, interaction) -> None: ...

    def logout(self, provider_id: str) -> None: ...
