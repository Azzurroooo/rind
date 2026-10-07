"""Worker resources and lifecycle."""

from __future__ import annotations

import asyncio
import json
import os
from functools import partial
from typing import Any

from agent.application.context import CompactionService
from agent.application.context.token_usage import positive_int
from agent.application.tools import ToolResultNormalizer
from agent.application.usage_summary import summarize_usage
from agent.domain.models import ModelSelection
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
from agent.infrastructure.tools.external import ExternalTool
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
        external_tool=None,
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
            external_tool=external_tool,
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
                self.session_id = str(info["session_id"]) or None
                self._initialized = True
                self._model_refresh_task = asyncio.create_task(
                    self.provider_service.refresh_stale_models(self.workspace_root),
                    name="refresh-stale-models",
                )
        if self.session_id:
            info = await self.repository.info(self.session_id)
            info["live_turn"] = self.execution.live_turn(self.session_id)
        else:
            info = await self.blank_info()
        info["base_url"] = workspace_defaults(info["workspace_root"])[2]
        return info

    async def blank_info(self, workspace_root: str | None = None) -> dict[str, Any]:
        root = workspace_root or self.workspace_root
        info = await self.repository.blank(root, self.provider_service.default_selection(root))
        info["live_turn"] = None
        return info

    async def session(self, session_id: str) -> dict[str, Any]:
        info = await self.repository.info(session_id)
        info["live_turn"] = self.execution.live_turn(session_id)
        return info

    async def create_session(self, workspace_root: str | None = None) -> dict[str, Any]:
        return await self.repository.create(workspace_root or self.workspace_root)

    async def open_session(self, params: dict) -> dict[str, Any]:
        root = validate_workspace_root(params.get("workspace_root") or self.workspace_root)
        info = await self.repository.initial(root, params.get("session_id"), params.get("resume_latest") is True)
        if os.path.normcase(info["workspace_root"]) != os.path.normcase(root):
            raise ValueError("Session workspace does not match the requested workspace.")
        session_id = info["session_id"]
        if not session_id:
            # Nothing exists yet; session/create configures the conversation on its first message.
            result = await self.blank_info(str(root))
            result["base_url"] = workspace_defaults(root)[2]
            return result
        tool = ExternalTool.from_json(json.dumps(params["external_tools"])) if params.get("external_tools") else None
        await self.execution.configure_session(session_id, tool, params.get("enable_user_question") is not False)
        result = await self.session(session_id)
        result["base_url"] = workspace_defaults(root)[2]
        return result

    async def start_execution(self, session_id: str) -> AgentContainer:
        return await self.execution.start(session_id)

    async def release_execution(self, session_id: str) -> None:
        await self.execution.release(session_id)

    async def create_conversation(self, params: dict) -> dict[str, Any]:
        """Create a conversation for its first message. The message saves it; nothing is written before."""
        for abandoned in self.repository.abandoned():
            await self.discard_unsaved(abandoned)
        root = validate_workspace_root(params.get("workspace_root") or self.workspace_root)
        default = self.provider_service.default_selection(root)
        selection = ModelSelection(
            provider_id=str(params.get("provider_id") or default.provider_id),
            model_id=str(params.get("model_id") or default.model_id),
            reasoning_effort=str(params["reasoning_effort"]) if params.get("reasoning_effort") is not None else default.reasoning_effort,
        )
        # A window may propose the identity it was given before a failed first prompt.
        proposed = validate_session_id(params["session_id"]) if params.get("session_id") else None
        if proposed and (self.repository.draft_store(proposed) is not None or await self.repository.exists(proposed)):
            raise ValueError("This conversation already exists.")
        info = await self.repository.create(str(root), selection=selection, defer_persistence=True, session_id=proposed)
        session_id = info["session_id"]
        if "external_tools" in params or "enable_user_question" in params:
            tool = ExternalTool.from_json(json.dumps(params["external_tools"])) if params.get("external_tools") else None
            await self.execution.configure_session(session_id, tool, params.get("enable_user_question") is not False)
        result = await self.session(session_id)
        result["base_url"] = workspace_defaults(root)[2]
        return result

    async def discard_unsaved(self, session_id: str) -> bool:
        """Drop a conversation that no message saved; it never existed on disk."""
        clean = validate_session_id(session_id)
        if self.repository.draft_store(clean) is None or clean in self.execution.active_session_ids():
            return False
        await self.execution.release(clean)
        self.execution.forget_options(clean)
        return self.repository.discard_unsaved(clean)

    async def replay(self, session_id: str, start: int | None = None, end: int | None = None) -> dict[str, Any]:
        await self.shell_tools.maintain_tasks(session_id)
        result = await self.repository.replay(session_id, start=start, end=end)
        result["live_turn"] = self.execution.live_turn(session_id)
        result["hosted"] = self.execution.owns_session(session_id)
        result["tasks"] = (await self.shell_tools.monitor_tasks(session_id))["tasks"]
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
            results = await asyncio.gather(
                self.execution.close(), self.shell_tools.close(), return_exceptions=True,
            )
            errors = [result for result in results if isinstance(result, BaseException)]
            if errors:
                raise BaseExceptionGroup("Worker shutdown failed: " + "; ".join(map(str, errors)), errors)
        finally:
            await asyncio.to_thread(self.web_sessions.close)
