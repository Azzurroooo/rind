import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.planning import build_plan_snapshot
from agent.infrastructure.tools.builtin.planning import update_plan


def _payload(raw: str) -> dict:
    value = json.loads(raw)
    assert isinstance(value, dict)
    return value


@pytest.mark.asyncio
async def test_plan_context_is_task_local_for_concurrent_sessions(tmp_path: Path, monkeypatch) -> None:
    env_root = tmp_path / "env_root"
    env_sid = "env_session"
    (env_root / env_sid).mkdir(parents=True)
    monkeypatch.setenv("AGENT_SESSION_ROOT", str(env_root))
    monkeypatch.setenv("AGENT_SESSION_ID", env_sid)

    session_root = tmp_path / "sessions"

    async def worker(session_id: str, step: str) -> tuple[dict, str]:
        session = JsonlSessionStore(
            session_dir=str(session_root),
            session_id=session_id,
            system_prompt="sys",
        )
        await session.initialize()
        result = _payload(
            await asyncio.to_thread(
                update_plan,
                [{"step": step, "status": "in_progress"}],
            )
        )
        return result, build_plan_snapshot()

    first, second = await asyncio.gather(
        worker("session_a", "step A"),
        worker("session_b", "step B"),
    )

    for session_id, step, result, snapshot in [
        ("session_a", "step A", first[0], first[1]),
        ("session_b", "step B", second[0], second[1]),
    ]:
        assert result["ok"] is True
        plan_file = session_root / session_id / "plan.json"
        stored = json.loads(plan_file.read_text(encoding="utf-8"))
        assert stored == {
            "schema_version": "2.0",
            "plan": [{"step": step, "status": "in_progress"}],
        }
        assert f"[in_progress] {step}" in snapshot

    assert not (env_root / env_sid / "plan.json").exists()
