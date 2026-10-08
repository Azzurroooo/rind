"""Folder defaults over the runtime protocol.

A folder's defaults decide what its new conversations start with (see
agent/infrastructure/workspace_defaults.py). Setting one is checked against
what the user can actually run: the connection must be configured and the
model listed for it.
"""

from __future__ import annotations

import asyncio
from typing import Any

from agent.domain.models import ModelSelection
from agent.infrastructure.paths import validate_workspace_root
from agent.infrastructure.settings import normalize_reasoning_effort

GROUPS = ("model", "reasoning_effort")


async def describe(worker, workspace_root: str) -> dict[str, Any]:
    """What the folder sets itself, and what a new conversation there starts with."""
    root = validate_workspace_root(workspace_root)
    repository = worker.repository
    own, resolved = await asyncio.gather(
        asyncio.to_thread(repository.workspace_defaults.get, root),
        asyncio.to_thread(repository.folder_selection, root),
    )
    return {
        "workspace_root": root,
        "folder": own,
        "resolved": {
            "provider": resolved.selection.provider_id,
            "model": resolved.selection.model_id,
            "reasoning_effort": resolved.selection.reasoning_effort,
            "model_source": resolved.model_source,
            "effort_source": resolved.effort_source,
        },
    }


async def set_defaults(worker, params: dict[str, Any]) -> dict[str, Any]:
    root = validate_workspace_root(str(params.get("workspace_root") or worker.workspace_root))
    provider = str(params.get("provider_id") or "").strip()
    model = str(params.get("model_id") or "").strip()
    effort = normalize_reasoning_effort(params.get("reasoning_effort"))
    if bool(provider) != bool(model):
        raise ValueError("A folder default model needs both provider_id and model_id.")
    if not model and not effort:
        raise ValueError("Set a model (provider_id and model_id), a reasoning_effort, or both.")
    models = (await worker.list_models())["models"]
    chosen = (provider, model) if model else _resolved_model(await describe(worker, root))
    listed = next((item for item in models if (item["provider_id"], item["id"]) == chosen), None)
    if model and listed is None:
        raise ValueError(f"{provider} / {model} is not available. Log in to {provider} with /login, or choose a listed model.")
    supported = listed.get("reasoning_efforts") if listed else None
    if effort and supported and effort not in supported:
        raise ValueError(f"{chosen[1]} supports reasoning effort {', '.join(supported)}, not {effort}.")
    defaults = worker.repository.workspace_defaults
    if model:
        await asyncio.to_thread(defaults.set_model, root, provider, model)
    if effort:
        await asyncio.to_thread(defaults.set_reasoning_effort, root, effort)
    return await describe(worker, root)


async def unset_defaults(worker, params: dict[str, Any]) -> dict[str, Any]:
    root = validate_workspace_root(str(params.get("workspace_root") or worker.workspace_root))
    group = str(params.get("group") or "")
    if group not in GROUPS:
        raise ValueError("group must be model or reasoning_effort.")
    await asyncio.to_thread(worker.repository.workspace_defaults.unset, root, group)
    return await describe(worker, root)


async def explain_selection(worker, workspace_root: str, selection: dict[str, str], source: dict[str, str] | None) -> dict[str, Any]:
    """For /status: the connection behind a selection, and where its model and effort came from.

    A conversation records its sources when created; before the first message
    (no `source`) they follow from comparing the window's choice with the defaults.
    """
    chosen = ModelSelection(selection.get("provider", ""), selection.get("model", ""), selection.get("reasoning_effort", ""))
    if source is None:
        chosen, source = await asyncio.to_thread(
            worker.repository.choose_selection, workspace_root, chosen.provider_id, chosen.model_id, selection.get("reasoning_effort"))
    connection = await asyncio.to_thread(worker.provider_service.describe_connection, chosen.provider_id)
    return {
        "provider": chosen.provider_id, "model": chosen.model_id, "reasoning_effort": chosen.reasoning_effort,
        "connection": connection, "model_source": source.get("model", ""), "effort_source": source.get("effort", ""),
    }


def _resolved_model(described: dict[str, Any]) -> tuple[str, str]:
    resolved = described["resolved"]
    return resolved["provider"], resolved["model"]
