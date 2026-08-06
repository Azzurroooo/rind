"""Composition root for the agent runtime."""

from __future__ import annotations

import os
from collections.abc import Collection
from dataclasses import dataclass

from agent.application.context import CompactionService, ContextEstimator, ContextManager
from agent.application.ports.session_store import SessionStore
from agent.application.runtime import AgentRuntime, MessageStreamParser, TurnRunner
from agent.application.skill_selection import SkillSelector
from agent.application.tools import ToolCallProcessor, ToolExecutor, ToolResultNormalizer
from agent.infrastructure.config import AppSettings, load_settings
from agent.infrastructure.llm import OpenAIChatClient, OpenAIClientFactory
from agent.infrastructure.persistence import JsonlSessionStore
from agent.infrastructure.planning import build_plan_snapshot
from agent.infrastructure.rind_docs import build_rind_doc_context
from agent.infrastructure.skills import SkillRepository
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin import build_builtin_tool_specs
from agent.prompts import SYSTEM_PROMPT


@dataclass(frozen=True, slots=True)
class AgentContainer:
    settings: AppSettings
    provider_client_factory: OpenAIClientFactory
    chat_client: OpenAIChatClient
    session_store: SessionStore
    tool_registry: DefaultToolRegistry
    tool_executor: ToolExecutor
    tool_result_normalizer: ToolResultNormalizer
    tool_processor: ToolCallProcessor
    stream_parser: MessageStreamParser
    context_estimator: ContextEstimator
    skill_repository: SkillRepository
    skill_selector: SkillSelector
    context_manager: ContextManager
    compaction_service: CompactionService
    turn_runner: TurnRunner
    runtime: AgentRuntime


def build_agent_container(
    *,
    settings: AppSettings | None = None,
    provider_client_factory: OpenAIClientFactory | None = None,
    debug: bool = False,
    session_dir: str | None = None,
    session_id: str | None = None,
    resume_latest: bool = False,
    enable_goal: bool = False,
    enable_user_question: bool = True,
    enabled_tools: Collection[str] | None = None,
    system_prompt: str | None = None,
    workspace_root: str | None = None,
    project_id: str | None = None,
    owner_agent_id: str | None = None,
    session_type: str | None = None,
    task_id: str | None = None,
    parent_session_id: str | None = None,
    created_by: str | None = None,
    skill_project_dir: str | None = None,
    agent_id: str | None = None,
) -> AgentContainer:
    """Build the production runtime dependency graph explicitly."""
    if agent_id or not workspace_root:
        from agent.infrastructure.team import discover_agent

        agent_context = discover_agent(agent_id=agent_id)
        if agent_context is not None:
            os.chdir(agent_context.workspace_root)
            agent_prompt = agent_context.capsule.system_prompt.strip()
            if system_prompt is None and agent_prompt:
                system_prompt = f"{SYSTEM_PROMPT}\n\n{agent_prompt}"
            workspace_root = workspace_root or str(agent_context.workspace_root)
            project_id = project_id if project_id is not None else agent_context.project_id
            owner_agent_id = owner_agent_id or agent_context.agent_id
            session_type = session_type or "direct_agent_chat"
            skill_project_dir = skill_project_dir or str(agent_context.capsule.manifest_path.parent / "skills")
    elif workspace_root:
        os.chdir(os.path.abspath(os.path.expanduser(workspace_root)))
    settings = settings or load_settings()
    provider_client_factory = provider_client_factory or OpenAIClientFactory(settings)
    model = settings.model
    session_store: SessionStore = JsonlSessionStore(
        session_dir=session_dir,
        session_id=session_id,
        resume_latest=resume_latest,
        model=model,
        system_prompt=system_prompt or SYSTEM_PROMPT,
        workspace_root=workspace_root,
        project_id=project_id,
        owner_agent_id=owner_agent_id,
        session_type=session_type,
        task_id=task_id,
        parent_session_id=parent_session_id,
        created_by=created_by,
    )
    catalog = build_builtin_tool_specs(
        enable_goal=enable_goal,
        enable_user_question=enable_user_question,
        set_goal_status=session_store.set_goal_status if enable_goal else None,
    )
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
    tool_result_normalizer = ToolResultNormalizer()
    tool_processor = ToolCallProcessor(
        tool_executor=tool_executor,
        tool_result_normalizer=tool_result_normalizer,
    )
    chat_client = OpenAIChatClient(
        async_client=provider_client_factory.create_async_client(),
        model=model,
        reasoning_effort=settings.reasoning_effort,
    )
    stream_parser = MessageStreamParser()
    context_estimator = ContextEstimator()
    skill_repository = SkillRepository(project_skill_dir=skill_project_dir)
    skill_selector = SkillSelector(max_active_skills=2)
    context_manager = ContextManager(
        estimator=context_estimator,
        skill_repository=skill_repository,
        skill_selector=skill_selector,
        rind_doc_provider=build_rind_doc_context,
    )
    compaction_service = CompactionService(
        plan_snapshot_provider=build_plan_snapshot,
    )
    turn_runner = TurnRunner(
        chat_client=chat_client,
        tool_processor=tool_processor,
        stream_parser=stream_parser,
        tool_schemas=tool_registry.schemas,
        context_manager=context_manager,
        compaction_service=compaction_service,
        debug=debug,
    )
    runtime = AgentRuntime(
        turn_runner=turn_runner,
        session_store=session_store,
        goal_enabled=enable_goal,
    )
    return AgentContainer(
        settings=settings,
        provider_client_factory=provider_client_factory,
        chat_client=chat_client,
        session_store=session_store,
        tool_registry=tool_registry,
        tool_executor=tool_executor,
        tool_result_normalizer=tool_result_normalizer,
        tool_processor=tool_processor,
        stream_parser=stream_parser,
        context_estimator=context_estimator,
        skill_repository=skill_repository,
        skill_selector=skill_selector,
        context_manager=context_manager,
        compaction_service=compaction_service,
        turn_runner=turn_runner,
        runtime=runtime,
    )
