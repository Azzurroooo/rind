"""Composition root for the agent runtime."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass

from agent.application.context import CompactionService, ContextEstimator, ContextManager
from agent.application.ports.session_store import SessionStore
from agent.application.runtime import AgentRuntime, MessageStreamParser, TurnRunner
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
    parent_session_id: str | None = None,
    skill_project_dir: str | None = None,
    lock_workspace: bool = True,
) -> AgentContainer:
    """Build the production runtime dependency graph explicitly."""
    skill_project_root = None
    skill_agent_dir = None
    resolved_team_agent = None
    from agent.infrastructure.team import discover_agent

    agent_context = discover_agent(workspace_root) if workspace_root else discover_agent()
    if agent_context is not None:
        if agent_context.project is not None:
            resolved_team_agent = agent_context
        agent_prompt = agent_context.capsule.system_prompt.strip()
        if system_prompt is None and agent_prompt:
            system_prompt = f"{SYSTEM_PROMPT}\n\n{agent_prompt}"
        workspace_root = str(agent_context.workspace_root)
        project_id = project_id if project_id is not None else agent_context.project_id
        owner_agent_id = owner_agent_id or agent_context.agent_id
        session_type = session_type or "direct_agent_chat"
        if agent_context.project is not None:
            skill_project_root = str(agent_context.project.project_root)
            skill_agent_dir = str(agent_context.capsule.manifest_path.parent / "skills")
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
        parent_session_id=parent_session_id,
    )
    skill_repository = SkillRepository(
        project_root=skill_project_root,
        project_skill_dir=skill_project_dir,
        agent_skill_dir=skill_agent_dir,
    )
    runtime_system_messages: list[dict] = []
    delegate_handler = None
    agent_create_project = None
    workspace_lock = None
    allowed_roots = None
    if resolved_team_agent is not None:
        from agent.infrastructure.team import WorkspaceLock, render_team_agent_catalog

        project = resolved_team_agent.project
        allowed_roots = (str(resolved_team_agent.workspace_root), str(project.shared_root))
        if lock_workspace:
            workspace_lock = WorkspaceLock(project.project_id, resolved_team_agent.agent_id)
        if resolved_team_agent.agent_id == project.main_agent:
            agent_create_project = project
            catalog_text = render_team_agent_catalog(project)
            main_agent_guidance = (
                "Use delegate for specialized Team work. Treat delegate results as concise explanations and "
                "verify published shared artifacts when evidence matters. Do not read another Agent's private "
                "workspace directly. Multiple delegate calls may run concurrently, including calls to the same "
                "Agent. They share that Agent's workspace, so avoid overlapping file writes and coordinate paths."
            )
            runtime_system_messages.append(
                {
                    "role": "system",
                    "content": f"{main_agent_guidance}\n\n{catalog_text}" if catalog_text else main_agent_guidance,
                    "_context_kind": "team_agent_catalog",
                }
            )
            from agent.bootstrap.delegation import TeamDelegator

            delegator = TeamDelegator(
                project=project,
                parent_session=session_store,
                settings=settings,
                provider_client_factory=provider_client_factory,
                session_dir=session_dir,
            )
            delegate_handler = delegator.delegate
    catalog = build_builtin_tool_specs(
        enable_goal=enable_goal,
        enable_user_question=enable_user_question,
        set_goal_status=session_store.set_goal_status if enable_goal else None,
        skill_repository=skill_repository,
        delegate_handler=delegate_handler,
        agent_create_project=agent_create_project,
        workspace_root=workspace_root,
        allowed_roots=allowed_roots,
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
    context_manager = ContextManager(estimator=context_estimator, rind_doc_provider=build_rind_doc_context)
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
        skill_repository=skill_repository,
        debug=debug,
    )
    runtime = AgentRuntime(
        turn_runner=turn_runner,
        session_store=session_store,
        goal_enabled=enable_goal,
        skill_repository=skill_repository,
        runtime_system_messages=runtime_system_messages,
        workspace_lock=workspace_lock,
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
        context_manager=context_manager,
        compaction_service=compaction_service,
        turn_runner=turn_runner,
        runtime=runtime,
    )
