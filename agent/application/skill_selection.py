"""Deterministic explicit selection of active skills for a user message."""

from __future__ import annotations

import re

from agent.domain.skills import Skill, SkillMatch


class SkillSelector:
    """Select skills only when the user explicitly writes $skill-name."""

    def __init__(self, max_active_skills: int = 2):
        self._max_active_skills = max(0, int(max_active_skills))

    def select(self, user_message: str, skills: list[Skill]) -> list[SkillMatch]:
        if self._max_active_skills <= 0 or not user_message or not skills:
            return []

        requested_names = [item.lower() for item in re.findall(r"\$([a-zA-Z0-9_-]+)", user_message)]
        skill_by_name = {skill.name.lower(): skill for skill in skills}
        matches: list[SkillMatch] = []
        seen: set[str] = set()

        for name in requested_names:
            if name in seen:
                continue
            skill = skill_by_name.get(name)
            if not skill:
                continue
            seen.add(name)
            matches.append(SkillMatch(skill=skill, reason="explicit_dollar_name", score=100))
            if len(matches) >= self._max_active_skills:
                break

        return matches
