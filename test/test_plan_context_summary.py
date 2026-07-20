import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.plans import PlanContextProvider
from agent.infrastructure.plans.state_summary import render_compact_plan_summary


def _write_plan(base: Path, plan: dict) -> None:
    base.mkdir(parents=True, exist_ok=True)
    (base / "plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")


def _plan(status: str = "active") -> dict:
    return {
        "plan_id": "p1",
        "title": "strategy_optimization",
        "goal": "Optimize to CAGR >= 10% and Sharpe >= 3",
        "summary": "stale factual summary should not be rendered",
        "status": status,
        "version": 7,
        "objectives": [{"metric": "sharpe", "operator": ">=", "target": 3.0, "current": 2.1}],
        "constraints": [{"metric": "max_drawdown", "operator": "<=", "target": 0.12, "current": 0.15}],
        "steps": [
            {"step_id": "s1", "title": "baseline", "status": "completed", "order": 0},
            {
                "step_id": "s2",
                "title": "test volatility filter",
                "status": "in_progress",
                "order": 1,
                "acceptance": "Sharpe improves without drawdown breach",
            },
            {"step_id": "s3", "title": "unlisted pending", "status": "pending", "order": 2},
        ],
    }


def test_render_compact_plan_summary_contains_key_state() -> None:
    text = render_compact_plan_summary(_plan(), char_limit=2000)

    for expected in [
        "Active plan summary:",
        "strategy_optimization (version 7)",
        "Optimize to CAGR >= 10% and Sharpe >= 3",
        "sharpe >= 3.0",
        "max_drawdown <= 0.12",
        "Current focus: s2 - test volatility filter",
    ]:
        if expected not in text:
            raise AssertionError(f"Expected {expected!r} in summary:\n{text}")
    for forbidden in [
        "Latest metrics",
        "Latest observation",
        "Hypothesis",
        "Next action",
        "current 2.1",
        "current 0.15",
        "stale factual summary",
    ]:
        if forbidden in text:
            raise AssertionError(f"Did not expect {forbidden!r} in summary:\n{text}")
    if "unlisted pending" in text:
        raise AssertionError(f"Did not expect full step list in summary:\n{text}")


def test_plan_context_provider_no_plan_and_closed_plan(tmp_path: Path) -> None:
    os.environ["AGENT_SESSION_ROOT"] = str(tmp_path)
    os.environ["AGENT_SESSION_ID"] = "sid"
    (tmp_path / "sid").mkdir()
    provider = PlanContextProvider()

    messages, stats, decisions = provider.build_context()
    if messages or decisions.get("plan_state") != "none":
        raise AssertionError(f"Expected no plan context, got: {messages}, {decisions}")

    _write_plan(tmp_path / "sid", _plan(status="completed"))
    messages, stats, decisions = provider.build_context()
    if messages or decisions.get("plan_state") != "closed":
        raise AssertionError(f"Expected closed plan without injection, got: {messages}, {decisions}")


def test_plan_context_provider_open_and_terminal_plan(tmp_path: Path) -> None:
    os.environ["AGENT_SESSION_ROOT"] = str(tmp_path)
    os.environ["AGENT_SESSION_ID"] = "sid"
    base = tmp_path / "sid"
    _write_plan(base, _plan())
    provider = PlanContextProvider(char_limit=2000)

    messages, stats, decisions = provider.build_context()
    if len(messages) != 1 or not messages[0]["content"].startswith("Active plan summary:"):
        raise AssertionError(f"Expected injected active summary, got: {messages}")
    if decisions.get("plan_state") != "open" or not decisions.get("plan_summary_injected"):
        raise AssertionError(f"Unexpected open decisions: {decisions}")
    if stats.get("plan_unfinished_step_count") != 2:
        raise AssertionError(f"Unexpected stats: {stats}")

    terminal = _plan()
    for step in terminal["steps"]:
        step["status"] = "completed"
    _write_plan(base, terminal)
    messages, stats, decisions = provider.build_context()
    if decisions.get("plan_state") != "terminal_open":
        raise AssertionError(f"Expected terminal_open, got: {decisions}")
    if "plan_close" not in messages[0]["content"] or "plan_add_step" not in messages[0]["content"]:
        raise AssertionError(f"Expected terminal maintenance hint, got: {messages}")


def test_plan_context_provider_truncates_and_handles_corruption(tmp_path: Path) -> None:
    os.environ["AGENT_SESSION_ROOT"] = str(tmp_path)
    os.environ["AGENT_SESSION_ID"] = "sid"
    base = tmp_path / "sid"
    plan = _plan()
    plan["goal"] = "x" * 1000
    _write_plan(base, plan)
    provider = PlanContextProvider(char_limit=120)

    messages, stats, decisions = provider.build_context()
    if len(messages[0]["content"]) > 120 or "truncated" not in messages[0]["content"]:
        raise AssertionError(f"Expected truncated summary, got: {messages}")

    (base / "plan.json").write_text("{bad json", encoding="utf-8")
    messages, stats, decisions = provider.build_context()
    if messages or decisions.get("plan_state") != "error":
        raise AssertionError(f"Expected error state without injection, got: {messages}, {decisions}")


def main() -> int:
    import tempfile

    test_render_compact_plan_summary_contains_key_state()
    with tempfile.TemporaryDirectory() as temp_dir:
        test_plan_context_provider_no_plan_and_closed_plan(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_plan_context_provider_open_and_terminal_plan(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_plan_context_provider_truncates_and_handles_corruption(Path(temp_dir))
    print("Plan context summary tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
