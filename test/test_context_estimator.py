import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application import ContextBudget, ContextEstimator
from agent.application.context.estimator import (
    DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
)

DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = (
    DEFAULT_CONTEXT_WINDOW_TOKENS * DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT // 100
)


def test_context_budget_codex_defaults() -> None:
    budget = ContextBudget.default()

    if budget.resolved_context_window_tokens() != DEFAULT_CONTEXT_WINDOW_TOKENS:
        raise AssertionError(f"Unexpected context window: {budget.to_dict()}")
    if budget.resolved_auto_compact_token_limit_percent() != DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT:
        raise AssertionError(f"Unexpected auto compact percent: {budget.to_dict()}")
    if budget.resolved_auto_compact_token_limit() != DEFAULT_AUTO_COMPACT_TOKEN_LIMIT:
        raise AssertionError(f"Unexpected auto compact limit: {budget.to_dict()}")


def test_context_budget_default_percent_threshold() -> None:
    budget = ContextBudget(context_window_tokens=1000)

    if budget.resolved_auto_compact_token_limit() != 900:
        raise AssertionError(f"Expected 90% threshold, got: {budget.to_dict()}")


def test_context_budget_custom_percent() -> None:
    budget = ContextBudget(context_window_tokens=2000, auto_compact_token_limit_percent=75)

    if budget.resolved_auto_compact_token_limit_percent() != 75:
        raise AssertionError(f"Expected custom percent, got: {budget.to_dict()}")
    if budget.resolved_auto_compact_token_limit() != 1500:
        raise AssertionError(f"Expected percent-derived threshold, got: {budget.to_dict()}")


def test_context_budget_tolerates_invalid_numeric_config() -> None:
    budget = ContextBudget(
        hard_limit_tokens="bad",
        context_window_tokens="invalid",
        auto_compact_token_limit_percent="nope",
    )

    if budget.resolved_context_window_tokens() != DEFAULT_CONTEXT_WINDOW_TOKENS:
        raise AssertionError(f"Expected default context window, got: {budget.to_dict()}")
    if budget.resolved_auto_compact_token_limit_percent() != DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT:
        raise AssertionError(f"Expected default auto compact percent, got: {budget.to_dict()}")
    if budget.resolved_auto_compact_token_limit() != DEFAULT_AUTO_COMPACT_TOKEN_LIMIT:
        raise AssertionError(f"Expected default auto compact limit, got: {budget.to_dict()}")
    if budget.resolved_hard_limit_tokens() != DEFAULT_CONTEXT_WINDOW_TOKENS:
        raise AssertionError(f"Expected fallback hard limit, got: {budget.to_dict()}")


def test_context_estimator_counts_chars_and_tokens() -> None:
    estimator = ContextEstimator(ContextBudget(hard_limit_tokens=20))
    messages = [
        {"role": "system", "content": "abcd"},
        {"role": "user", "content": "efghijkl"},
        {"role": "assistant", "tool_calls": [{"id": "call_1"}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "tool output"},
    ]

    estimate = estimator.estimate_messages(messages)

    if estimate.message_count != 4:
        raise AssertionError(f"Unexpected message count: {estimate}")
    if estimate.estimated_chars <= 0:
        raise AssertionError(f"Expected chars > 0, got: {estimate}")
    if estimate.estimated_input_tokens <= 0:
        raise AssertionError(f"Unexpected token estimate: {estimate}")
    if estimate.system_tokens <= 0:
        raise AssertionError(f"Expected system tokens > 0, got: {estimate}")
    if estimate.conversation_tokens <= 0:
        raise AssertionError(f"Expected conversation tokens > 0, got: {estimate}")
    if estimate.tool_tokens <= 0:
        raise AssertionError(f"Expected tool tokens > 0, got: {estimate}")

    # Check if sum matches
    expected_total_tokens = estimate.system_tokens + estimate.conversation_tokens + estimate.tool_tokens
    if estimate.estimated_input_tokens != expected_total_tokens:
        raise AssertionError(f"Total tokens {estimate.estimated_input_tokens} != sum of parts {expected_total_tokens}")


def test_context_estimator_limit_flags() -> None:
    estimator = ContextEstimator(ContextBudget(hard_limit_tokens=12))
    messages = [{"role": "user", "content": "x" * 60}]

    estimate = estimator.estimate_messages(messages)

    if estimate.over_hard_limit is not True:
        raise AssertionError(f"Expected over hard limit, got: {estimate}")


def main() -> int:
    test_context_budget_codex_defaults()
    test_context_budget_default_percent_threshold()
    test_context_budget_custom_percent()
    test_context_budget_tolerates_invalid_numeric_config()
    test_context_estimator_counts_chars_and_tokens()
    test_context_estimator_limit_flags()
    print("ContextEstimator tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
