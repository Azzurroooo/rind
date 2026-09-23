"""Worker resources and lifecycle."""

from __future__ import annotations

import asyncio
from functools import partial
from typing import Any

from agent.application.context import CompactionService
from agent.application.context.token_usage import positive_int
from agent.application.tools import ToolResultNormalizer
from agent.application.usage_summary import summarize_usage
from agent.bootstrap import AgentContainer, SharedRuntimeResources
from agent.infrastructure.llm import ProviderServiceImpl
from agent.infrastructure.paths import validate_session_id, validate_workspace_root
from agent.infrastructure.persistence import ToolOutputStore
from agent.infrastructure.persistence.plan import build_plan_snapshot
from agent.infrastructure.persistence.usage_ledger import (
    append_usage_record,
    default_usage_ledger_path,
    load_usage_records,
)
from agent.infrastructure.settings import workspace_defaults
from agent.infrastructure.tools.shell.tool import ShellTools
from agent.infrastructure.tools.web.session_pool import WebSessions
from agent.runtime.core import MessageStreamParser
from agent.runtime.server.execution import ExecutionCoordinator
from agent.runtime.server.session_service import SessionService


class RuntimeWorker:
    """Application-scoped worker with persistent session access and active turns."""

    def __init__(
        self,
        *,
        workspace_root: str,
        session_id: str | None = None,
        resume_latest: bool = False,
        session_dir: str | None = None,
        debug: bool = False,
        enable_goal: bool = True,
        enable_user_question: bool = True,
    ):
        self.workspace_root = validate_workspace_root(workspace_root)
        self.session_id = session_id
        self._resume_latest = resume_latest
        tool_output_store = ToolOutputStore(session_dir)
        usage_recorder = partial(append_usage_record, default_usage_ledger_path())
        self._shared_resources = SharedRuntimeResources(
            tool_result_normalizer=ToolResultNormalizer(),
            stream_parser=MessageStreamParser(),
            compaction_service=CompactionService(
                plan_snapshot_provider=build_plan_snapshot,
                usage_recorder=usage_recorder,
            ),
            tool_output_store=tool_output_store,
        )
        self.shell_tools = ShellTools(tool_output_store)
        self.web_sessions = WebSessions()
        self.provider_service = ProviderServiceImpl()
        self.repository = SessionService(session_dir=session_dir, provider_service=self.provider_service)
        self.execution = ExecutionCoordinator(
            shared_resources=self._shared_resources,
            shell_tools=self.shell_tools,
            web_sessions=self.web_sessions,
            repository=self.repository,
            debug=debug,
            enable_goal=enable_goal,
            enable_user_question=enable_user_question,
            session_dir=session_dir,
            provider_service=self.provider_service,
        )
        self._initialized = False
        self._model_refresh_task: asyncio.Task[None] | None = None
        self._initialize_lock = asyncio.Lock()
        self._tool_output_store = tool_output_store

    async def initialize(self) -> dict[str, Any]:
        async with self._initialize_lock:
            if not self._initialized:
                await self._tool_output_store.cleanup()
                info = await self.repository.initial(
                    self.workspace_root,
                    self.session_id,
                    self._resume_latest,
                    self.provider_service.default_selection(self.workspace_root),
                )
                self.session_id = str(info["session_id"])
                self._initialized = True
                self._model_refresh_task = asyncio.create_task(
                    self.provider_service.refresh_stale_models(self.workspace_root),
                    name="refresh-stale-models",
                )
        info = await self.repository.info(self.session_id)
        info["base_url"] = workspace_defaults(info["workspace_root"])[2]
        info["live_turn"] = self.execution.live_turn(self.session_id)
        return info

    async def session(self, session_id: str) -> dict[str, Any]:
        info = await self.repository.info(session_id)
        info["live_turn"] = self.execution.live_turn(session_id)
        return info

    async def create_session(self, workspace_root: str | None = None) -> dict[str, Any]:
        return await self.repository.create(workspace_root or self.workspace_root)

    async def start_execution(self, session_id: str) -> AgentContainer:
        return await self.execution.start(session_id)

    async def release_execution(self, session_id: str) -> None:
        await self.execution.release(session_id)

    async def replay(self, session_id: str, start: int | None = None, end: int | None = None) -> dict[str, Any]:
        result = await self.repository.replay(session_id, start=start, end=end)
        result["live_turn"] = self.execution.live_turn(session_id)
        result["tasks"] = await self.shell_tools.list_backgrounds(session_id)
        result["background_wait"] = await self.execution.background_wait(session_id)
        return result

    async def replay_event_pages(self, session_id: str) -> dict[str, Any]:
        return await self.repository.replay_event_pages(session_id)

    async def delete_session(self, session_id: str) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        self.execution.interrupt(clean, "Session deleted")
        await self.execution.release(clean, permanent=True)
        await self.shell_tools.close_session(clean)
        return await self.repository.delete(clean)

    async def fork_session(self, session_id: str, before_message_id: str | None = None) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        return await self.repository.fork(clean, before_message_id)

    async def usage_summary(self, days: int = 7) -> dict[str, Any]:
        """Summarize the user-level usage ledger; every number traces to a raw row."""
        window = max(1, min(positive_int(days, 7), 365))
        records = await asyncio.to_thread(load_usage_records, default_usage_ledger_path())
        return summarize_usage(records, window)

    def list_providers(self, workspace_root: str | None = None) -> list[dict[str, Any]]:
        return [
            {
                "id": status.id,
                "name": status.name,
                "methods": list(status.methods),
                "configured": status.configured,
                "source": status.source,
            }
            for status in self.provider_service.list_providers(workspace_root or self.workspace_root)
        ]

    async def login(self, provider_id: str, method: str, interaction, workspace_root: str | None = None) -> None:
        await self.provider_service.login(workspace_root or self.workspace_root, provider_id, method, interaction)

    def logout(self, provider_id: str) -> bool:
        return self.provider_service.logout(provider_id)

    async def list_models(self, workspace_root: str | None = None, *, refresh: bool = False) -> dict[str, Any]:
        catalog = await self.provider_service.list_models(workspace_root or self.workspace_root, refresh=refresh)
        return {
            "models": [
                {
                    "provider_id": model.provider_id,
                    "id": model.id,
                    "name": model.name,
                    "api": model.api,
                    "reasoning_efforts": list(model.reasoning_efforts),
                    "context_window": model.context_window,
                    "image_input": model.image_input,
                }
                for model in catalog.models
            ],
            "warning": catalog.warning,
        }

    async def close(self) -> None:
        self.shell_tools.supervisor.stop_accepting()
        if self._model_refresh_task is not None:
            self._model_refresh_task.cancel()
            await asyncio.gather(self._model_refresh_task, return_exceptions=True)
            self._model_refresh_task = None
        try:
            await self.execution.close()
        finally:
            try:
                await self.shell_tools.close()
            finally:
                await asyncio.to_thread(self.web_sessions.close)
