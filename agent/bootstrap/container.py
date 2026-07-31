"""Composition root for the agent runtime."""

from __future__ import annotations

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
from agent.infrastructure.tools.builtin import TOOL_SPECS, create_goal_tool_spec
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
) -> AgentContainer:
    """Build the production runtime dependency graph explicitly."""
    settings = settings or load_settings()
    provider_client_factory = provider_client_factory or OpenAIClientFactory(settings)
    model = settings.model
    session_store: SessionStore = JsonlSessionStore(
        session_dir=session_dir,
        session_id=session_id,
        resume_latest=resume_latest,
        model=model,
        system_prompt=SYSTEM_PROMPT,
    )
    tool_specs = list(TOOL_SPECS)
    if enable_goal:
        tool_specs.append(create_goal_tool_spec(session_store.set_goal_status))
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
    skill_repository = SkillRepository()
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
