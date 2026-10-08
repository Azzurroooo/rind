"""Composition root for the agent runtime."""

from __future__ import annotations

import inspect
from collections.abc import Collection
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any

from agent.application.context import CompactionService, ContextEstimator, ContextManager
from agent.application.ports.session_store import SessionStore
from agent.application.tools import ToolCallProcessor, ToolExecutor, ToolResultNormalizer
from agent.infrastructure.environment import get_system_info
from agent.infrastructure.persistence import JsonlSessionStore, ToolOutputStore
from agent.infrastructure.persistence.plan import build_plan_snapshot
from agent.infrastructure.persistence.usage_ledger import append_usage_record, default_usage_ledger_path
from agent.infrastructure.rind_docs import build_rind_doc_context
from agent.infrastructure.settings import AppSettings, load_settings
from agent.infrastructure.skills import SkillRepository
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.catalog import build_builtin_tool_specs
from agent.infrastructure.tools.files.mutation_queue import FileMutationQueue
from agent.infrastructure.tools.shell.tool import ShellTools
from agent.infrastructure.tools.web.session_pool import WebSessions
from agent.application.images import prepare_image_messages
from agent.prompts import build_goal_policy_prompt, build_system_prompt
from agent.runtime.core import AgentRuntime, MessageStreamParser, TurnRunner
from agent.application.task_notifications import TaskNotifications


@dataclass(frozen=True, slots=True)
class SharedRuntimeResources:
    """Worker-scoped resources without session-bound mutable state."""

    tool_result_normalizer: ToolResultNormalizer
    stream_parser: MessageStreamParser
    compaction_service: CompactionService
    tool_output_store: ToolOutputStore = field(default_factory=ToolOutputStore)
    file_mutation_queue: FileMutationQueue = field(default_factory=FileMutationQueue)


@dataclass(frozen=True, slots=True)
class AgentContainer:
    settings: AppSettings
    chat_client: Any
    session_store: SessionStore
    tool_registry: DefaultToolRegistry
    tool_executor: ToolExecutor
    tool_result_normalizer: ToolResultNormalizer
    tool_processor: ToolCallProcessor
    stream_parser: MessageStreamParser
    skill_repository: SkillRepository
    context_manager: ContextManager
    compaction_service: CompactionService
    turn_runner: TurnRunner
    runtime: AgentRuntime
    shell_tools: ShellTools
    web_sessions: WebSessions


def build_agent_container(
    *,
    chat_client,
    image_input: bool | None = None,
    settings: AppSettings | None = None,
    session_dir: str | None = None,
    session_id: str | None = None,
    session_store: SessionStore | None = None,
    resume_latest: bool = False,
    enable_goal: bool = False,
    enable_user_question: bool = True,
    enabled_tools: Collection[str] | None = None,
    system_prompt: str | None = None,
    workspace_root: str | None = None,
    project_id: str | None = None,
    owner_agent_id: str | None = None,
    session_type: str | None = None,
    parent_session_id: str | None = None,
    skill_project_dir: str | None = None,
    shared_resources: SharedRuntimeResources | None = None,
    shell_tools: ShellTools | None = None,
    web_sessions: WebSessions | None = None,
    task_notifications: TaskNotifications | None = None,
    external_tool=None,
) -> AgentContainer:
    """Build the production runtime dependency graph explicitly."""
    prompt_workspace = str(Path(workspace_root or Path.cwd()).expanduser().resolve())
    settings = settings or load_settings()
    tool_output_store = shared_resources.tool_output_store if shared_resources else ToolOutputStore(session_dir)
    shell_tools = shell_tools or ShellTools(tool_output_store)
    task_notifications = task_notifications or TaskNotifications(shell_tools.supervisor.journal)
    web_sessions = web_sessions or WebSessions()
    model = settings.model
    session_store = session_store if session_store is not None else JsonlSessionStore(
        session_dir=session_dir,
        session_id=session_id,
        resume_latest=resume_latest,
        model=model,
        system_prompt=system_prompt or build_system_prompt(prompt_workspace, environment=get_system_info(prompt_workspace)),
        workspace_root=workspace_root,
        project_id=project_id,
        owner_agent_id=owner_agent_id,
        session_type=session_type,
        parent_session_id=parent_session_id,
        reasoning_effort=settings.reasoning_effort,
        provider=settings.provider,
    )
    trace_setter = getattr(chat_client, "set_trace_session_id_provider", None)
    if callable(trace_setter) and not inspect.iscoroutinefunction(trace_setter):
        trace_setter(lambda: session_store.session_id)
    skill_repository = SkillRepository(
        project_root=prompt_workspace,
        project_skill_dir=skill_project_dir,
        skill_files=external_tool.skill_files if external_tool else (),
    )
    runtime_system_messages: list[dict] = []
    if external_tool:
        if external_tool.instructions:
            runtime_system_messages.append({"role": "system", "content": external_tool.instructions, "_context_kind": "external_tools"})
        if external_tool.enabled_tools is not None:
            enabled_tools = external_tool.enabled_tools
    if enable_goal:
        runtime_system_messages.append(
            {
                "role": "system",
                "content": build_goal_policy_prompt(),
                "_context_kind": "goal_policy",
            }
        )
    session_output_root = None
    if session_id:
        session_output_root = str(
            (Path(JsonlSessionStore.resolve_session_root(session_dir)) / str(session_id) / "tool-output")
            .expanduser()
            .resolve()
        )
    catalog = build_builtin_tool_specs(
        enable_goal=enable_goal,
        enable_user_question=enable_user_question,
        set_goal_status=session_store.set_goal_status if enable_goal else None,
        skill_repository=skill_repository,
        workspace_root=workspace_root,
        session_output_root=session_output_root,
        shell_tools=shell_tools,
        web_sessions=web_sessions,
        mutation_queue=shared_resources.file_mutation_queue if shared_resources else None,
        session_base_provider=lambda: session_store.session_base_path,
        capture_image=session_store.capture_image,
        image_input=image_input,
    )
    if external_tool:
        catalog = (*catalog, external_tool.spec(session_store.session_id))
    if enabled_tools is None:
        tool_specs = catalog
    else:
        requested = set(enabled_tools)
        known = {spec.name for spec in catalog}
        unknown = sorted(requested - known)
        if unknown:
            raise ValueError(f"Unknown enabled tool(s): {', '.join(unknown)}")
        tool_specs = tuple(spec for spec in catalog if spec.name in requested)
    tool_registry = DefaultToolRegistry(tool_specs)
    tool_executor = ToolExecutor(registry=tool_registry)
    tool_result_normalizer = shared_resources.tool_result_normalizer if shared_resources else ToolResultNormalizer()
    tool_processor = ToolCallProcessor(
        tool_executor=tool_executor,
        tool_result_normalizer=tool_result_normalizer,
        tool_output_store=tool_output_store,
        task_notifications=task_notifications,
    )
    stream_parser = shared_resources.stream_parser if shared_resources else MessageStreamParser()
    context_manager = ContextManager(
        estimator=ContextEstimator(),
        rind_doc_provider=lambda: build_rind_doc_context(workspace_root),
    )
    usage_recorder = partial(append_usage_record, default_usage_ledger_path())
    compaction_service = shared_resources.compaction_service if shared_resources else CompactionService(
        plan_snapshot_provider=build_plan_snapshot,
        usage_recorder=usage_recorder,
    )
    turn_runner = TurnRunner(
        chat_client=chat_client,
        tool_processor=tool_processor,
        stream_parser=stream_parser,
        tool_schemas=tool_registry.schemas,
        prepare_messages=partial(prepare_image_messages, load_image=session_store.load_image, image_input=image_input),
        image_input=image_input,
        context_manager=context_manager,
        task_notifications=task_notifications,
        compaction_service=compaction_service,
        skill_repository=skill_repository,
        usage_recorder=usage_recorder,
    )
    runtime = AgentRuntime(
        turn_runner=turn_runner,
        session_store=session_store,
        goal_enabled=enable_goal,
        skill_repository=skill_repository,
        runtime_system_messages=runtime_system_messages,
    )
    return AgentContainer(
        settings=settings,
        chat_client=chat_client,
        session_store=session_store,
        tool_registry=tool_registry,
        tool_executor=tool_executor,
        tool_result_normalizer=tool_result_normalizer,
        tool_processor=tool_processor,
        stream_parser=stream_parser,
        skill_repository=skill_repository,
        context_manager=context_manager,
        compaction_service=compaction_service,
        turn_runner=turn_runner,
        runtime=runtime,
        shell_tools=shell_tools,
        web_sessions=web_sessions,
    )
