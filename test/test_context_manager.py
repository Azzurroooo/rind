import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ContextBudget, ContextEstimate, ContextEstimator, ContextManager
from agent.application.context.estimator import DEFAULT_CONTEXT_WINDOW_TOKENS

class QueryOnlySession:
    def __init__(self, messages):
        self._messages = [dict(message) for message in messages]

    async def get_messages_slice(self, start=None, end=None, roles=None):
        messages = [dict(message) for message in self._messages]
        if roles:
            allowed = set(roles)
            messages = [message for message in messages if message.get("role") in allowed]
        return messages[slice(start, end)]


class UsageSession(QueryOnlySession):
    def __init__(self, messages, *, assistant_usage=None, auto_compact_window=None):
        super().__init__(messages)
        self._assistant_usage = assistant_usage
        self._auto_compact_window = auto_compact_window or {"ordinal": 1}

    async def get_latest_assistant_sampling_usage(self):
        return dict(self._assistant_usage) if isinstance(self._assistant_usage, dict) else None

    async def get_compact_generation(self):
        return int(self._auto_compact_window.get("ordinal") or 1)


class FixedEstimator:
    def __init__(self, budget: ContextBudget, tokens: int, chars: int = 1000):
        self._budget = budget
        self._tokens = tokens
        self._chars = chars

    @property
    def budget(self) -> ContextBudget:
        return self._budget

    def estimate_messages(self, messages):
        return ContextEstimate(
            message_count=len(messages),
            estimated_input_tokens=self._tokens,
            estimated_chars=self._chars,
            system_tokens=1,
            conversation_tokens=max(0, self._tokens - 1),
            tool_tokens=0,
            over_hard_limit=self._tokens >= self._budget.resolved_hard_limit_tokens(),
        )


@pytest.mark.asyncio
async def test_context_manager_builds_from_session_queries() -> None:
    session_messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "world"},
        {"role": "tool", "tool_call_id": "c1", "content": "tool output"},
    ]
    manager = ContextManager(
        estimator=ContextEstimator(
            ContextBudget(hard_limit_tokens=950, conversation_budget_tokens=900, tool_budget_tokens=900)
        )
    )
    session = QueryOnlySession(session_messages)

    result = await manager.build_messages_async(session=session)

    if result.messages != session_messages:
        raise AssertionError(f"Expected session-backed messages, got: {result.messages}")
    if result.stats.get("persisted_message_count") != 4:
        raise AssertionError(f"Unexpected stats: {result.stats}")
    if "estimated_input_tokens" not in result.stats:
        raise AssertionError(f"Expected estimate in stats, got: {result.stats}")
    if result.stats.get("context_window_tokens") != DEFAULT_CONTEXT_WINDOW_TOKENS:
        raise AssertionError(f"Expected Codex-style context window stats, got: {result.stats}")
    if "context_usage_percent" not in result.stats:
        raise AssertionError(f"Expected context usage percent, got: {result.stats}")
    if result.decisions.get("source") != "session_queries":
        raise AssertionError(f"Unexpected decisions: {result.decisions}")
    if result.decisions.get("compact_required") is not False:
        raise AssertionError(f"Unexpected compact decision: {result.decisions}")
    for key in ("tool_policy_applied", "rolling_summary_applied", "rolling_summary_generated"):
        if key in result.decisions:
            raise AssertionError(f"Did not expect legacy decision key {key}, got: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_appends_pending_messages() -> None:
    session_messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ]
    pending = [{"role": "assistant", "content": "pending reply"}]
    session = QueryOnlySession(session_messages)

    result = await ContextManager().build_messages_async(session=session, pending_messages=pending)

    if result.messages != session_messages + pending:
        raise AssertionError(f"Expected pending overlay appended, got: {result.messages}")
    if result.stats.get("pending_message_count") != 1:
        raise AssertionError(f"Unexpected pending stats: {result.stats}")
    if result.decisions.get("uses_pending_overlay") is not True:
        raise AssertionError(f"Unexpected pending decisions: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_build_is_stable_and_has_no_summary_side_effects() -> None:
    session_messages = [{"role": "system", "content": "sys"}]
    for index in range(8):
        session_messages.append({"role": "user", "content": f"user message {index} " + ("x" * 80)})
        session_messages.append({"role": "assistant", "content": f"assistant reply {index} " + ("y" * 80)})
    session = QueryOnlySession(session_messages)
    manager = ContextManager(
        estimator=ContextEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                conversation_budget_tokens=20,
                tool_budget_tokens=80,
                context_window_tokens=100,
                auto_compact_token_limit_percent=20,
            )
        ),
        hot_message_limit=4,
    )

    first = await manager.build_messages_async(session=session)
    second = await manager.build_messages_async(session=session)

    if first.messages != second.messages or first.messages != session_messages:
        raise AssertionError(f"Expected stable append-only projection, got: {first.messages} / {second.messages}")
    for key in ("summary_message_count", "cold_compacted_message_count", "hot_tool_message_count"):
        if key in first.stats:
            raise AssertionError(f"Did not expect legacy stat key {key}, got: {first.stats}")
    if first.decisions.get("auto_compact_token_limit_reached") is not True:
        raise AssertionError(f"Expected auto compact token limit reached, got: {first.decisions}")
    if first.decisions.get("compact_required") is not False:
        raise AssertionError(f"Did not expect hard-limit compact requirement, got: {first.decisions}")


@pytest.mark.asyncio
async def test_context_manager_uses_assistant_usage_anchor_for_auto_compact() -> None:
    session = UsageSession(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "large local estimate " + ("x" * 2000)},
        ],
        assistant_usage={
            "sampling_kind": "assistant",
            "input_tokens": 50,
            "anchor": {
                "local_estimated_input_tokens": 200,
                "local_estimated_chars": 1000,
                "context_message_count": 2,
                "compact_generation": 1,
            },
        },
    )
    manager = ContextManager(
        estimator=FixedEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            ),
            tokens=220,
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_token_source"] == "assistant_usage_plus_local_delta"
    assert result.stats["auto_compact_active_tokens"] == 70
    assert result.stats["auto_compact_local_delta_tokens"] == 20
    assert result.stats["auto_compact_anchor_usable"] is True
    assert result.decisions["auto_compact_token_limit_reached"] is False


@pytest.mark.asyncio
async def test_context_manager_triggers_when_anchor_plus_delta_reaches_limit() -> None:
    session = UsageSession(
        [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}],
        assistant_usage={
            "sampling_kind": "assistant",
            "input_tokens": 90,
            "anchor": {
                "local_estimated_input_tokens": 200,
                "compact_generation": 1,
            },
        },
    )
    manager = ContextManager(
        estimator=FixedEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            ),
            tokens=220,
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_active_tokens"] == 110
    assert result.decisions["auto_compact_token_limit_reached"] is True


@pytest.mark.asyncio
async def test_context_manager_falls_back_to_estimate_without_server_usage() -> None:
    session = QueryOnlySession(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "large local estimate " + ("x" * 2000)},
        ]
    )
    manager = ContextManager(
        estimator=ContextEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            )
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_token_source"] == "local_estimate"
    assert result.stats["auto_compact_active_tokens"] == result.stats["estimated_input_tokens"]
    assert result.stats["auto_compact_anchor_fallback_reason"] == "missing_usage"
    assert result.decisions["auto_compact_token_limit_reached"] is True

@pytest.mark.asyncio
async def test_context_manager_missing_anchor_uses_local_estimate() -> None:
    session = UsageSession(
        [{"role": "system", "content": "sys"}, {"role": "user", "content": "small"}],
        assistant_usage={"sampling_kind": "assistant", "input_tokens": 900},
        auto_compact_window={"ordinal": 2},
    )
    manager = ContextManager(
        estimator=ContextEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            )
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_token_source"] == "local_estimate"
    assert result.stats["auto_compact_active_tokens"] == result.stats["estimated_input_tokens"]
    assert result.stats["auto_compact_anchor_fallback_reason"] == "missing_anchor"
    assert result.decisions["auto_compact_token_limit_reached"] is False


@pytest.mark.asyncio
async def test_context_manager_generation_mismatch_falls_back_to_local_estimate() -> None:
    session = UsageSession(
        [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}],
        assistant_usage={
            "sampling_kind": "assistant",
            "input_tokens": 20,
            "anchor": {
                "local_estimated_input_tokens": 80,
                "compact_generation": 1,
            },
        },
        auto_compact_window={
            "ordinal": 2,
        },
    )
    manager = ContextManager(
        estimator=FixedEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            ),
            tokens=150,
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_token_source"] == "local_estimate"
    assert result.stats["auto_compact_anchor_fallback_reason"] == "compact_generation_mismatch"
    assert result.stats["auto_compact_active_tokens"] == 150
    assert result.decisions["auto_compact_token_limit_reached"] is True


@pytest.mark.asyncio
async def test_context_manager_compact_usage_does_not_act_as_anchor() -> None:
    session = UsageSession(
        [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}],
        assistant_usage={
            "sampling_kind": "compact",
            "input_tokens": 20,
            "anchor": {
                "local_estimated_input_tokens": 80,
                "compact_generation": 1,
            },
        },
    )
    manager = ContextManager(
        estimator=FixedEstimator(
            ContextBudget(
                hard_limit_tokens=5000,
                context_window_tokens=1000,
                auto_compact_token_limit_percent=10,
            ),
            tokens=150,
        )
    )

    result = await manager.build_messages_async(session=session)

    assert result.stats["auto_compact_token_source"] == "local_estimate"
    assert result.stats["auto_compact_anchor_fallback_reason"] == "non_assistant_usage"
    assert result.decisions["auto_compact_token_limit_reached"] is True


@pytest.mark.asyncio
async def test_context_manager_does_not_inject_plan_and_reports_skill_error_type() -> None:
    class BrokenCatalogSession(QueryOnlySession):
        async def get_skill_catalog(self):
            raise RuntimeError("bad skills")

    session = BrokenCatalogSession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ])
    manager = ContextManager()

    result = await manager.build_messages_async(session=session)

    assert all("plan" not in key for key in result.stats)
    assert all("plan" not in key for key in result.decisions)
    if result.decisions.get("skill_error_type") != "RuntimeError":
        raise AssertionError(f"Expected skill error type, got: {result.decisions}")


@pytest.mark.asyncio
async def test_context_manager_reports_rind_provider_error() -> None:
    def broken_rind_provider():
        raise RuntimeError("bad docs")

    session = QueryOnlySession([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ])
    manager = ContextManager(rind_doc_provider=broken_rind_provider)

    result = await manager.build_messages_async(session=session)

    assert result.messages == session._messages
    assert result.decisions["rind_docs_injected"] is False
    assert result.decisions["rind_docs_error_type"] == "RuntimeError"


@pytest.mark.asyncio
async def test_context_manager_new_tool_append_does_not_change_old_tool_content() -> None:
    session_messages = [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "tool_calls": [{"id": "old", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "old", "content": "old fixed model content"},
    ]
    session = QueryOnlySession(session_messages)
    manager = ContextManager()

    first = await manager.build_messages_async(session=session)
    session._messages.extend(
        [
            {"role": "assistant", "tool_calls": [{"id": "new", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "new", "content": "new fixed model content"},
        ]
    )
    second = await manager.build_messages_async(session=session)

    old_first = next(message for message in first.messages if message.get("tool_call_id") == "old")
    old_second = next(message for message in second.messages if message.get("tool_call_id") == "old")
    if old_first != old_second:
        raise AssertionError(f"Expected old tool content to remain fixed, got {old_first} / {old_second}")


def main() -> int:
    import asyncio

    async def _run_all():
        await test_context_manager_builds_from_session_queries()
        await test_context_manager_appends_pending_messages()
        await test_context_manager_build_is_stable_and_has_no_summary_side_effects()
        await test_context_manager_uses_assistant_usage_anchor_for_auto_compact()
        await test_context_manager_triggers_when_anchor_plus_delta_reaches_limit()
        await test_context_manager_falls_back_to_estimate_without_server_usage()
        await test_context_manager_missing_anchor_uses_local_estimate()
        await test_context_manager_generation_mismatch_falls_back_to_local_estimate()
        await test_context_manager_compact_usage_does_not_act_as_anchor()
        await test_context_manager_does_not_inject_plan_and_reports_skill_error_type()
        await test_context_manager_reports_rind_provider_error()
        await test_context_manager_new_tool_append_does_not_change_old_tool_content()

    asyncio.run(_run_all())
    print("ContextManager tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
