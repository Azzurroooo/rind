"""Context provider for session-local plan summaries."""

from __future__ import annotations

from typing import Any

from .model import ensure_plan_defaults
from .store import load_plan_if_exists
from .state_summary import plan_state, render_compact_plan_summary, unfinished_steps


class PlanContextProvider:
    """Build compact model-facing context for the current session plan."""

    def __init__(self, char_limit: int = 2200):
        self._char_limit = max(0, int(char_limit))

    def build_context(self) -> tuple[list[dict], dict, dict]:
        stats = {
            "plan_summary_chars": 0,
            "plan_open": False,
            "plan_step_count": 0,
            "plan_unfinished_step_count": 0,
        }
        decisions = {
            "plan_summary_injected": False,
            "plan_id": None,
            "plan_version": None,
            "plan_state": "none",
        }

        try:
            plan = load_plan_if_exists()
        except FileNotFoundError:
            return [], stats, decisions
        except Exception:
            decisions["plan_state"] = "error"
            return [], stats, decisions

        if not plan:
            return [], stats, decisions

        ensure_plan_defaults(plan)
        steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
        unfinished = unfinished_steps(plan)
        state = plan_state(plan)
        stats.update(
            {
                "plan_open": state in {"open", "terminal_open"},
                "plan_step_count": len(steps),
                "plan_unfinished_step_count": len(unfinished),
            }
        )
        decisions.update(
            {
                "plan_id": plan.get("plan_id"),
                "plan_version": plan.get("version"),
                "plan_state": state,
            }
        )

        if state not in {"open", "terminal_open"}:
            return [], stats, decisions

        content = render_compact_plan_summary(plan, self._char_limit)
        if not content:
            return [], stats, decisions

        stats["plan_summary_chars"] = len(content)
        decisions["plan_summary_injected"] = True
        return [{"role": "system", "content": content}], stats, decisions
