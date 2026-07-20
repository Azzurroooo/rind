"""Composition root for wiring concrete adapters to application services."""

from __future__ import annotations

from agent.application import ContextManager, ToolExecutor
from agent.application.services.skill_selector import SkillSelector
from agent.application.runtime.async_runtime_facade import AsyncRuntimeFacade
from agent.application.runtime.async_turn_runner import AsyncTurnRunner
from agent.application.runtime.message_stream_parser import MessageStreamParser
from agent.application.ports.async_session_store import AsyncSessionStore
from agent.infrastructure.config import Config
from agent.infrastructure.tangerine_docs import build_tangerine_doc_context
from agent.infrastructure.llm.openai_async_chat_client import AsyncOpenAIChatClient
from agent.infrastructure.persistence.async_jsonl_session_store import AsyncJsonlSessionStore
from agent.infrastructure.plans import PlanContextProvider
from agent.infrastructure.skills import SkillRepository
from agent.infrastructure.tools import DefaultToolRegistry
from agent.interfaces.cli import ChatCLI
from agent.prompts import SYSTEM_PROMPT


def build_basic_agent_dependencies(
    *,
    tools=None,
    debug: bool = False,
    session_dir: str | None = None,
    session_id: str | None = None,
    resume_latest: bool = False,
) -> dict[str, object]:
    model = Config.DEFAULT_MODEL
    async_client = Config.get_async_client()

    session: AsyncSessionStore = AsyncJsonlSessionStore(
        session_dir=session_dir,
        session_id=session_id,
        resume_latest=resume_latest,
        model=model,
        system_prompt=SYSTEM_PROMPT,
    )

    tool_registry = DefaultToolRegistry(schemas=tools)
    tool_executor = ToolExecutor(registry=tool_registry)

    async_chat_client = AsyncOpenAIChatClient(
        async_client=async_client,
        model=model,
        reasoning_effort=Config.MODEL_REASONING_EFFORT,
    )
    plan_context_provider = PlanContextProvider(char_limit=2200)
    skill_repository = SkillRepository()
    skill_selector = SkillSelector(max_active_skills=2)

    from agent.application.runtime.async_tool_call_processor import AsyncToolCallProcessor
    async_tool_processor = AsyncToolCallProcessor(tool_executor=tool_executor)

    stream_parser = MessageStreamParser()

    turn_runner = AsyncTurnRunner(
        chat_client=async_chat_client,
        tool_processor=async_tool_processor,
        stream_parser=stream_parser,
        tool_schemas=tool_registry.schemas,
        context_manager=ContextManager(
            skill_repository=skill_repository,
            skill_selector=skill_selector,
            plan_context_provider=plan_context_provider,
            tangerine_doc_provider=build_tangerine_doc_context,
        ),
        debug=debug,
    )

    runtime = AsyncRuntimeFacade(turn_runner=turn_runner, session_store=session)

    cli = ChatCLI(runtime=runtime, session=session, debug=debug)

    return {
        "chat_client": async_chat_client,
        "session": session,
        "tool_registry": tool_registry,
        "runtime": runtime,
        "cli": cli,
        "skill_repository": skill_repository,
        "skill_selector": skill_selector,
        "plan_context_provider": plan_context_provider,
    }
