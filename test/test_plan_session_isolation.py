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

from agent.infrastructure.persistence.async_jsonl_session_store import AsyncJsonlSessionStore
from agent.infrastructure.plans import PlanContextProvider
from agent.infrastructure.tools.impl.tools.plan import plan_create


def _payload(raw: str) -> dict:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return data


@pytest.mark.asyncio
async def test_plan_context_is_task_local_for_concurrent_sessions(tmp_path: Path, monkeypatch) -> None:
    env_root = tmp_path / "env_root"
    env_sid = "env_session"
    (env_root / env_sid).mkdir(parents=True)
    monkeypatch.setenv("AGENT_SESSION_ROOT", str(env_root))
    monkeypatch.setenv("AGENT_SESSION_ID", env_sid)

    session_root = tmp_path / "sessions"

    async def worker(session_id: str, title: str) -> tuple[dict, list[dict], dict]:
        session = AsyncJsonlSessionStore(
            session_dir=str(session_root),
            session_id=session_id,
            system_prompt="sys",
        )
        await session.initialize()
        await asyncio.sleep(0)
        result = _payload(
            await asyncio.to_thread(
                plan_create,
                title,
                f"goal for {session_id}",
                [{"step_id": "s1", "title": "first"}],
            )
        )
        messages, _, decisions = PlanContextProvider(char_limit=2000).build_context()
        return result, messages, decisions

    first, second = await asyncio.gather(
        worker("session_a", "Plan A"),
        worker("session_b", "Plan B"),
    )

    for session_id, title, result in [
        ("session_a", "Plan A", first),
        ("session_b", "Plan B", second),
    ]:
        payload, messages, decisions = result
        if payload.get("ok") is not True:
            raise AssertionError(f"Expected ok payload for {session_id}, got: {payload}")
        plan_file = session_root / session_id / "plan.json"
        if not plan_file.exists():
            raise AssertionError(f"Expected plan in session-local directory: {plan_file}")
        stored = json.loads(plan_file.read_text(encoding="utf-8"))
        if stored.get("title") != title:
            raise AssertionError(f"Expected {title!r} in {plan_file}, got: {stored}")
        if decisions.get("plan_id") != stored.get("plan_id"):
            raise AssertionError(f"Expected context provider to read {session_id} plan, got: {decisions}")
        if not messages or title not in messages[0].get("content", ""):
            raise AssertionError(f"Expected injected summary for {title}, got: {messages}")

    if (env_root / env_sid / "plan.json").exists():
        raise AssertionError("Expected task-local session context to override global env fallback.")
