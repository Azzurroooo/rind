"""Long-lived runtime worker and explicit session registry."""

from __future__ import annotations

import asyncio
import inspect
import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from agent.application.context import CompactionService
from agent.application.tools import ToolResultNormalizer
from agent.bootstrap import AgentContainer, SharedRuntimeResources, build_agent_container
from agent.infrastructure.config import AppSettings
from agent.infrastructure.llm import OpenAIClientFactory
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.paths import validate_session_id
from agent.infrastructure.planning import build_plan_snapshot
from agent.runtime.core import MessageStreamParser


@dataclass(slots=True)
class SessionRuntime:
    session_id: str
    workspace_root: str
    container: AgentContainer

    @property
    def runtime(self):
        return self.container.runtime

    @property
    def session(self):
        return self.container.session_store

    @property
    def active_turn_id(self) -> str:
        return self.runtime.active_turn_id


class SessionRegistry:
    """Resolve persistent session IDs to independent in-process runtimes."""

    def __init__(
        self,
        *,
        settings: AppSettings,
        provider_client_factory: OpenAIClientFactory,
        session_dir: str | None,
        debug: bool,
        enable_goal: bool,
    ):
        self._settings = settings
        self._provider_client_factory = provider_client_factory
        self._provider_async_client = provider_client_factory.create_async_client()
        self._shared_resources = SharedRuntimeResources(
            provider_async_client=self._provider_async_client,
            tool_result_normalizer=ToolResultNormalizer(),
            stream_parser=MessageStreamParser(),
            compaction_service=CompactionService(plan_snapshot_provider=build_plan_snapshot),
        )
        self._storage_dir = session_dir
        self._debug = debug
        self._enable_goal = enable_goal
        self._sessions: dict[str, SessionRuntime] = {}
        self._lock = asyncio.Lock()

    @property
    def default_model(self) -> str:
        return self._settings.model

    @property
    def provider_client_factory(self) -> OpenAIClientFactory:
        return self._provider_client_factory

    @property
    def model_client(self):
        return self._provider_async_client

    async def open(self, session_id: str) -> SessionRuntime:
        clean = validate_session_id(session_id)
        existing = self._sessions.get(clean)
        if existing is not None:
            return existing
        meta = JsonlSessionStore.load_session_metadata(clean, self._storage_dir)
        workspace_root = meta.get("workspace_root") or meta.get("cwd")
        if not isinstance(workspace_root, str) or not workspace_root.strip():
            raise ValueError(f"Session {clean} has no workspace root.")
        return await self._build(clean, workspace_root)

    async def create(self, workspace_root: str) -> SessionRuntime:
        return await self._build(_new_session_id(), workspace_root)

    async def initial(
        self,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
    ) -> SessionRuntime:
        if session_id:
            return await self.open(session_id)
        if resume_latest:
            sessions = JsonlSessionStore.list_session_metadata(
                self._storage_dir,
                limit=1,
                workspace_root=workspace_root,
            )
            if not sessions:
                raise ValueError("No existing session found to resume.")
            return await self.open(str(sessions[0]["id"]))
        return await self.create(workspace_root)

    async def _build(self, session_id: str, workspace_root: str) -> SessionRuntime:
        async with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                return existing
            root = _normalize_workspace_root(workspace_root)
            container = build_agent_container(
                settings=self._settings,
                provider_client_factory=self._provider_client_factory,
                debug=self._debug,
                session_dir=self._storage_dir,
                session_id=session_id,
                enable_goal=self._enable_goal,
                workspace_root=root,
                shared_resources=self._shared_resources,
            )
            await container.runtime.initialize()
            runtime = SessionRuntime(session_id=session_id, workspace_root=root, container=container)
            self._sessions[session_id] = runtime
            return runtime

    async def list_sessions(self, limit: int = 20, workspace_root: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            JsonlSessionStore.list_session_metadata,
            self._storage_dir,
            limit,
            workspace_root,
        )

    async def close(self) -> None:
        sessions = list(self._sessions.values())
        self._sessions.clear()
        for session in sessions:
            try:
                await session.session.discard_if_empty()
            except Exception:
                continue
        close = getattr(self._provider_async_client, "close", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result


class RuntimeWorker:
    """Application-scoped worker shared by all surface requests."""

    def __init__(
        self,
        *,
        settings: AppSettings,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
        session_dir: str | None = None,
        debug: bool = False,
        enable_goal: bool = True,
    ):
        self.workspace_root = _normalize_workspace_root(workspace_root)
        self.session_id = session_id
        self._resume_latest = resume_latest
        self.registry = SessionRegistry(
            settings=settings,
            provider_client_factory=OpenAIClientFactory(settings),
            session_dir=session_dir,
            debug=debug,
            enable_goal=enable_goal,
        )
        self._initial_session: SessionRuntime | None = None

    @property
    def default_model(self) -> str:
        return self.registry.default_model

    @property
    def provider_client_factory(self) -> OpenAIClientFactory:
        return self.registry.provider_client_factory

    @property
    def model_client(self):
        return self.registry.model_client

    async def initialize(self) -> SessionRuntime:
        if self._initial_session is None:
            self._initial_session = await self.registry.initial(
                self.workspace_root,
                self.session_id,
                self._resume_latest,
            )
            self.session_id = self._initial_session.session_id
        return self._initial_session

    async def session(self, session_id: str) -> SessionRuntime:
        return await self.registry.open(session_id)

    async def create_session(self, workspace_root: str | None = None) -> SessionRuntime:
        root = workspace_root or (self._initial_session.workspace_root if self._initial_session else self.workspace_root)
        return await self.registry.create(root)

    async def close(self) -> None:
        await self.registry.close()
        self._initial_session = None


def _new_session_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def _normalize_workspace_root(value: str) -> str:
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace directory does not exist: {root}")
    return os.path.normcase(str(root))
