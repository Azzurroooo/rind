"""Context composition snapshot bucketing rules."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.context.estimator import ContextEstimator
from agent.application.context.snapshot import build_context_snapshot
from agent.domain.compaction import (
    COMPACT_CONTINUATION_USER_CONTENT,
    COMPACT_HANDOFF_REASONING_CONTENT,
)


ESTIMATOR = ContextEstimator()


def _sections(snapshot):
    return {section["key"]: section for section in snapshot["sections"]}


def test_mixed_messages_produce_the_full_bucket_set():
    messages = [
        {"role": "system", "content": "You are Rind. " * 10},
        {"role": "system", "content": "--- user-doc ---\n\nuser doc", "_context_kind": "rind_docs"},
        {"role": "system", "content": "catalog", "_context_kind": "skill_catalog"},
        {"role": "system", "content": "goal policy", "_context_kind": "goal_policy"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there", "reasoning_content": "chain of thought"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{}"}},
            {"id": "c2", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": "out1"},
        {"role": "tool", "tool_call_id": "c1", "content": "out1b"},
        {"role": "tool", "tool_call_id": "c2", "content": "file body"},
        {"role": "user", "content": "continue", "meta": {"kind": "compact_boundary", "compact_id": "x"}},
        {"role": "system", "content": "created", "_context_kind": "mystery_tag"},
    ]
    stats = pipeline_stats(messages)

    snapshot = build_context_snapshot(messages, stats, "turn-1", estimator=ESTIMATOR)
    sections = _sections(snapshot)

    assert snapshot["estimated_total"] == stats["estimated_input_tokens"]
    assert snapshot["context_window_tokens"] == 4096
    assert snapshot["turn_id"] == "turn-1"
    assert snapshot["captured_at"]
    assert sum(section["tokens"] for section in snapshot["sections"]) == stats["estimated_input_tokens"]
    for key in (
        "system_prompt",
        "rind_docs_user",
        "skill_catalog",
        "goal_policy",
        "chat_user",
        "chat_assistant",
        "reasoning",
        "tool:bash",
        "tool:read_file",
        "compaction_handoff",
        "kind:mystery_tag",
    ):
        assert key in sections, f"missing bucket {key}"
    assert sections["tool:bash"]["messages"] == 2
    assert sections["tool:read_file"]["messages"] == 1
    # Unknown tags form their own bucket under their original name.
    assert sections["kind:mystery_tag"]["label"] == "mystery_tag"


def pipeline_stats(messages):
    estimate = ESTIMATOR.estimate_messages(messages)
    return {
        "estimated_input_tokens": estimate.estimated_input_tokens,
        "context_window_tokens": 4096,
    }


def test_section_tokens_sum_to_the_stats_total_with_zero_drift():
    messages = [
        {"role": "system", "content": "system prompt " * 20},
        {"role": "system", "content": "--- user-doc ---\n\nuser\n\n--- project-doc ---\n\nproject", "_context_kind": "rind_docs"},
        {"role": "user", "content": "question? " * 5},
        {"role": "assistant", "content": "answer " * 10, "reasoning_content": "thinking " * 8},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c9", "type": "function", "function": {"name": "bash", "arguments": "ls"}},
        ]},
        {"role": "tool", "tool_call_id": "c9", "content": "output " * 30},
    ]
    stats = pipeline_stats(messages)

    snapshot = build_context_snapshot(messages, stats, "", estimator=ESTIMATOR)

    assert sum(section["tokens"] for section in snapshot["sections"]) == stats["estimated_input_tokens"]
    assert snapshot["estimated_total"] == stats["estimated_input_tokens"]


def test_rind_docs_with_two_scopes_splits_into_two_rows():
    messages = [
        {
            "role": "system",
            "content": "--- user-doc ---\n\n" + "user rules " * 30 + "\n\n--- project-doc ---\n\n" + "project rules " * 30,
            "_context_kind": "rind_docs",
        },
    ]
    stats = {"estimated_input_tokens": 500, "context_window_tokens": 8192}

    sections = _sections(build_context_snapshot(messages, stats, "", estimator=ESTIMATOR))

    assert set(sections) == {"rind_docs_user", "rind_docs_project"}
    assert sections["rind_docs_user"]["label"] == "RIND.md · user"
    assert sections["rind_docs_project"]["label"] == "RIND.md · project"
    assert sections["rind_docs_user"]["tokens"] > 0
    assert sections["rind_docs_project"]["tokens"] > 0


def test_same_name_tools_aggregate_and_six_tools_yield_an_other_row():
    messages = [
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": name, "arguments": "{}"}},
        ]}
        for i, name in enumerate(["bash", "bash", "bash", "t1", "t2", "t3", "t4", "t5", "t6"])
    ]
    for i in range(9):
        messages.append({"role": "tool", "tool_call_id": f"c{i}", "content": "out"})
    stats = {"estimated_input_tokens": 800, "context_window_tokens": 8192}

    sections = _sections(build_context_snapshot(messages, stats, "", estimator=ESTIMATOR))

    assert sections["tool:bash"]["messages"] == 3
    for name in ("t1", "t2", "t3", "t4"):
        assert sections[f"tool:{name}"]["messages"] == 1
    # Six distinct tools beyond bash: the four most frequent get rows, the rest merge.
    assert "tool:t5" not in sections
    assert "tool:t6" not in sections
    assert sections["tool:other"]["messages"] == 2
    assert sections["tool:other"]["label"] == "Tool results · other"


def test_compaction_handoff_constants_bucket_together():
    messages = [
        {"role": "user", "content": COMPACT_CONTINUATION_USER_CONTENT},
        {"role": "assistant", "content": "summary", "reasoning_content": COMPACT_HANDOFF_REASONING_CONTENT},
        {"role": "user", "content": "fresh question"},
    ]
    stats = {"estimated_input_tokens": 300, "context_window_tokens": 8192}

    sections = _sections(build_context_snapshot(messages, stats, "", estimator=ESTIMATOR))

    assert sections["compaction_handoff"]["messages"] == 2
    assert sections["compaction_handoff"]["label"] == "Compaction handoff"
    assert sections["chat_user"]["messages"] == 1


def test_assistant_reasoning_splits_into_its_own_bucket():
    messages = [
        {"role": "assistant", "content": "visible answer " * 20, "reasoning_content": "hidden reasoning " * 20},
    ]
    stats = {"estimated_input_tokens": 0, "context_window_tokens": 8192}

    sections = _sections(build_context_snapshot(messages, stats, "", estimator=ESTIMATOR))

    assert sections["chat_assistant"]["tokens"] > 0
    assert sections["reasoning"]["tokens"] > 0
    assert sections["chat_assistant"]["tokens"] + sections["reasoning"]["tokens"] == (
        ESTIMATOR.estimate_messages(messages).estimated_input_tokens
    )


def test_empty_message_list_does_not_throw():
    snapshot = build_context_snapshot([], {"estimated_input_tokens": 0, "context_window_tokens": 100}, "")

    assert snapshot["sections"] == []
    assert snapshot["estimated_total"] == 0
    assert snapshot["context_window_tokens"] == 100


def test_missing_stats_fall_back_to_the_section_sum():
    messages = [{"role": "user", "content": "only message"}]

    snapshot = build_context_snapshot(messages, {}, "")

    assert snapshot["estimated_total"] == sum(section["tokens"] for section in snapshot["sections"])
    assert snapshot["context_window_tokens"] > 0


def test_sections_are_ranked_by_tokens_descending():
    messages = [
        {"role": "user", "content": "short"},
        {"role": "assistant", "content": "a much longer assistant reply " * 20},
    ]
    stats = {"estimated_input_tokens": 0, "context_window_tokens": 8192}

    snapshot = build_context_snapshot(messages, stats, "", estimator=ESTIMATOR)

    tokens = [section["tokens"] for section in snapshot["sections"]]
    assert tokens == sorted(tokens, reverse=True)
