"""Deterministic parsing of explicit Skill invocation syntax."""

from __future__ import annotations

from dataclasses import dataclass
import re

from agent.domain.skills import LoadedSkill, render_skill_content


_DOLLAR_MENTION_PATTERN = re.compile(r"\$([A-Za-z0-9_-]+)")
_SLASH_PREFIX_PATTERN = re.compile(r"^\s*/skill:([A-Za-z0-9_-]+)(?=\s|$)", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class SkillInvocation:
    name: str
    syntax: str


class SkillInvocationParser:
    """Parse only explicit /skill:name and $skill-name forms."""

    def parse(self, user_message: str) -> list[SkillInvocation]:
        if not isinstance(user_message, str) or not user_message:
            return []

        invocations: list[SkillInvocation] = []
        seen: set[str] = set()
        slash_match = _SLASH_PREFIX_PATTERN.match(user_message)
        if slash_match:
            name = slash_match.group(1)
            key = name.lower()
            seen.add(key)
            invocations.append(SkillInvocation(name=name, syntax="slash"))

        for match in _DOLLAR_MENTION_PATTERN.finditer(user_message):
            name = match.group(1)
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            invocations.append(SkillInvocation(name=name, syntax="dollar"))
        return invocations


class SkillTurnCoordinator:
    """Resolve explicit Skill mentions and persist their immutable snapshots."""

    def __init__(self, repository, parser: SkillInvocationParser | None = None):
        self._repository = repository
        self._parser = parser or SkillInvocationParser()

    async def persist_user_input(self, session, text: str) -> list[SkillInvocation]:
        invocations = self._parser.parse(text)
        loaded: list[tuple[SkillInvocation, LoadedSkill]] = []
        for invocation in invocations:
            skill = self._repository.load_skill(invocation.name)
            if skill is None:
                if invocation.syntax == "slash":
                    raise ValueError(f"Unknown Skill: {invocation.name}")
                continue
            loaded.append((invocation, skill))

        mention_meta = None
        if loaded:
            mention_meta = {
                "kind": "user_prompt",
                "skill_invocations": [
                    {"name": skill.name, "syntax": invocation.syntax}
                    for invocation, skill in loaded
                ],
            }
        if mention_meta is None:
            await session.persist_message("user", text)
        else:
            await session.persist_message("user", text, meta=mention_meta)
        for invocation, skill in loaded:
            await session.persist_message(
                "user",
                render_skill_content(skill),
                meta={
                    "kind": "skill_snapshot",
                    "name": skill.name,
                    "scope": skill.scope,
                    "path": skill.path,
                    "syntax": invocation.syntax,
                },
            )
        return [invocation for invocation, _skill in loaded]
