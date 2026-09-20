"""Session access and the unpersisted startup draft."""

from __future__ import annotations

import asyncio
import shutil
from typing import Any

from agent.domain.models import ModelSelection
from agent.infrastructure.environment import get_system_info
from agent.infrastructure.llm import ProviderServiceImpl
from agent.infrastructure.paths import resolve_session_base, validate_session_id, validate_workspace_root
from agent.infrastructure.persistence import JsonlSessionStore, fork_session
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.persistence.session_index_repository import SessionIndexRepository
from agent.infrastructure.persistence.session_meta import new_session_id
from agent.infrastructure.settings import workspace_defaults
from agent.infrastructure.team import discover_agent
from agent.prompts import build_system_prompt


class SessionService:
    """Access sessions by ID, retaining only the unpersisted startup draft."""

    def __init__(self, *, session_dir: str | None, provider_service: ProviderServiceImpl):
        self.session_dir = session_dir
        self.provider_service = provider_service
        self._draft_store: JsonlSessionStore | None = None

    def draft_store(self, session_id: str) -> JsonlSessionStore | None:
        self.release_persisted_draft()
        if self._draft_store is not None and self._draft_store.session_id == session_id:
            return self._draft_store
        return None

    def release_persisted_draft(self) -> None:
        if self._draft_store is not None and self._draft_store.is_persisted:
            self._draft_store = None

    async def metadata(self, session_id: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        draft = self.draft_store(clean)
        if draft is not None:
            return await draft.get_metadata()
        return await asyncio.to_thread(JsonlSessionStore.load_session_metadata, clean, self.session_dir)

    async def list(self, limit: int = 20, workspace_root: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            JsonlSessionStore.list_session_metadata,
            self.session_dir,
            limit,
            workspace_root,
        )

    async def delete(self, session_id: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        meta = await self.metadata(clean)
        if self.draft_store(clean) is not None:
            self._draft_store = None
            return {"session_id": clean, "workspace_root": str(meta.get("workspace_root") or "")}

        def _remove() -> None:
            root = JsonlSessionStore.resolve_session_root(self.session_dir)
            base = resolve_session_base(root, clean)
            if base.exists():
                shutil.rmtree(base)
            SessionIndexRepository(
                SessionFiles(), JsonlSessionStore.index_path_for(self.session_dir)
            ).remove_session(clean)

        await asyncio.to_thread(_remove)
        return {"session_id": clean, "workspace_root": str(meta.get("workspace_root") or "")}

    async def fork(self, session_id: str, before_message_id: str | None = None) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        if self.draft_store(clean) is not None:
            raise ValueError("Nothing to fork: the session has no user messages.")
        meta = await asyncio.to_thread(JsonlSessionStore.load_session_metadata, clean, self.session_dir)
        if meta.get("session_type") == "delegated_task":
            raise ValueError("Delegated task sessions cannot be forked.")
        new_id = await asyncio.to_thread(fork_session, self.session_dir, clean, before_message_id=before_message_id)
        return {"session_id": new_id, "forked_from": clean}

    async def create(
        self,
        workspace_root: str,
        *,
        project_id: str | None = None,
        owner_agent_id: str | None = None,
        session_type: str | None = None,
        parent_session_id: str | None = None,
        selection: ModelSelection | None = None,
        defer_persistence: bool = False,
    ) -> dict[str, Any]:
        root = validate_workspace_root(workspace_root)
        if selection is None:
            selection = self.provider_service.default_selection(root)
        model, reasoning_effort, provider = selection.model_id, selection.reasoning_effort, selection.provider_id
        agent_context = discover_agent(root)
        if project_id is None and agent_context:
            project_id = agent_context.project_id
        if owner_agent_id is None and agent_context:
            owner_agent_id = agent_context.agent_id
        if session_type is None and agent_context:
            session_type = "direct_agent_chat"
        system_prompt = build_system_prompt(str(root), environment=get_system_info(root))
        agent_prompt = agent_context.capsule.system_prompt.strip() if agent_context else ""
        if agent_prompt:
            system_prompt = f"{system_prompt}\n\n{agent_prompt}"
        store = JsonlSessionStore(
            session_dir=self.session_dir,
            session_id=new_session_id(),
            model=model,
            system_prompt=system_prompt,
            workspace_root=root,
            project_id=project_id,
            owner_agent_id=owner_agent_id,
            session_type=session_type,
            parent_session_id=parent_session_id,
            reasoning_effort=reasoning_effort,
            provider=provider,
        )
        if defer_persistence:
            await store.create_session(session_id=store.session_id)
            self._draft_store = store
        else:
            await store.initialize()
        return {
            "session_id": store.session_id,
            "draft": not store.is_persisted,
            "model": store.model,
            "provider": store.provider,
            "reasoning_effort": store.reasoning_effort,
            "workspace_root": root,
            "turn_state": None,
            "team_main": _team_main_info(root),
        }

    async def initial(
        self,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
        selection: ModelSelection | None = None,
    ) -> dict[str, Any]:
        if session_id:
            return await self.info(session_id)
        if resume_latest:
            sessions = await self.list(limit=1, workspace_root=workspace_root)
            if not sessions:
                raise ValueError("No existing session found to resume.")
            return await self.info(str(sessions[0]["id"]))
        return await self.create(workspace_root, selection=selection, defer_persistence=True)

    async def info(self, session_id: str) -> dict[str, Any]:
        meta = await self.metadata(session_id)
        workspace_root = str(meta.get("workspace_root") or meta.get("cwd") or "")
        default_model, default_effort, _, default_provider = await asyncio.to_thread(workspace_defaults, workspace_root)
        return {
            "session_id": str(meta.get("session_id") or session_id),
            "draft": self.draft_store(session_id) is not None,
            "model": str(meta.get("model") or default_model),
            "provider": str(meta.get("provider") or default_provider),
            "reasoning_effort": str(meta.get("reasoning_effort") or default_effort or ""),
            "workspace_root": workspace_root,
            "team_main": await asyncio.to_thread(_team_main_info, workspace_root),
            "project_id": meta.get("project_id"),
            "owner_agent_id": meta.get("owner_agent_id"),
            "session_type": meta.get("session_type"),
            "parent_session_id": meta.get("parent_session_id"),
            "turn_state": meta.get("turn_state") if isinstance(meta.get("turn_state"), dict) else None,
            "goal": meta.get("goal") if isinstance(meta.get("goal"), dict) else None,
            "usage": meta.get("latest_sampling_usage") if isinstance(meta.get("latest_sampling_usage"), dict) else None,
            "message_count": int(meta.get("message_count") or 0),
        }

    async def replay(self, session_id: str, start: int | None = None, end: int | None = None) -> dict[str, Any]:
        info = await self.info(session_id)
        store = await self._open_store_from_info(
            session_id,
            info,
            persist_system_prompt=False,
        )
        messages = await store.get_messages_slice(
            start=start,
            end=end,
            include_ids=True,
            compacted=False,
        )
        return {
            "messages": messages,
            "turn_state": await store.get_turn_state(),
            "session_id": session_id,
            "model": store.model,
        }

    async def replay_event_pages(self, session_id: str) -> dict[str, Any]:
        """Load the raw materials for durable event projection with one store open."""
        info = await self.info(session_id)
        store = await self._open_store_from_info(
            session_id,
            info,
            persist_system_prompt=False,
        )
        return {
            "messages": await store.get_messages_slice(include_ids=True, compacted=False),
            "tool_records": await store.get_tool_records(),
            "turn_state": await store.get_turn_state(),
            "session_id": session_id,
        }

    async def open_store(
        self,
        session_id: str,
        workspace_root: str | None = None,
        *,
        persist_system_prompt: bool = True,
    ):
        clean = validate_session_id(session_id)
        info = await self.info(clean)
        return await self._open_store_from_info(
            clean,
            info,
            workspace_root=workspace_root,
            persist_system_prompt=persist_system_prompt,
        )

    async def _open_store_from_info(
        self,
        session_id: str,
        info: dict[str, Any],
        *,
        workspace_root: str | None = None,
        persist_system_prompt: bool = True,
    ):
        clean = validate_session_id(session_id)
        root = validate_workspace_root(workspace_root or info["workspace_root"])
        draft = self.draft_store(clean)
        if draft is not None:
            if root != draft.workspace_root:
                raise ValueError("Session workspace_root is immutable and does not match the requested agent context.")
            return draft
        store = JsonlSessionStore(
            session_dir=self.session_dir,
            session_id=clean,
            model=info["model"],
            provider=info.get("provider") or "openai-compatible",
            system_prompt=build_system_prompt(str(root), environment=get_system_info(root)),
            workspace_root=root,
            reasoning_effort=info.get("reasoning_effort") or "",
        )
        await store.initialize(persist_system_prompt=persist_system_prompt)
        return store

    async def get_goal(self, session_id: str) -> dict[str, str] | None:
        store = await self.open_store(session_id, persist_system_prompt=False)
        return await store.get_goal()

    async def set_goal(self, session_id: str, objective: str) -> dict[str, str]:
        store = await self.open_store(session_id)
        return await store.set_goal(objective)

    async def set_goal_status(self, session_id: str, status: str) -> dict[str, str]:
        store = await self.open_store(session_id)
        return await store.set_goal_status(status)

    async def clear_goal(self, session_id: str) -> None:
        store = await self.open_store(session_id)
        await store.clear_goal()


def _team_main_info(workspace_root: str) -> dict[str, str] | None:
    """Optional display identity, derived from the current Team manifests."""
    if not workspace_root:
        return None
    try:
        agent = discover_agent(workspace_root)
    except (OSError, ValueError):
        return None
    if agent is None or agent.project is None or agent.agent_id != agent.project.main_agent:
        return None
    return {"agent_id": agent.agent_id, "project_name": agent.project.name}
