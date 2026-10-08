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
    def default_selection(self) -> ModelSelection: ...

    def resolve_selection(self, selection: ModelSelection) -> ModelDefinition: ...

    def list_providers(self) -> list[ProviderStatus]: ...

    async def list_models(self, *, refresh: bool = False) -> ModelCatalog: ...

    async def refresh_stale_models(self) -> None: ...

    async def login(self, provider_id: str, method: str, interaction) -> None: ...

    def logout(self, provider_id: str) -> None: ...
