"""UI metadata must never leak into model-facing message projections."""
from copy import deepcopy

from agent.infrastructure.persistence.message_projector import project_messages


def test_replay_retains_timestamp_by_identity_without_changing_model_messages():
    history = [
        {"id": "u1", "ts": "2026-09-29T06:00:00Z", "role": "user", "content": "same"},
        {"id": "a1", "ts": "2026-09-29T06:00:02Z", "role": "assistant", "content": "answer"},
        {"id": "u2", "ts": "2026-09-30T06:00:00Z", "role": "user", "content": "same"},
        {"id": "old", "role": "assistant", "content": "no time"},
    ]
    before = deepcopy(history)
    replay = project_messages(history, [], [], "", include_ids=True, compacted=False)
    assert [item.get("ts") for item in replay] == [item.get("ts") for item in history]
    model = project_messages(history, [], [], "", compacted=False)
    assert model == [{"role": item["role"], "content": item["content"]} for item in history]
    assert history == before
