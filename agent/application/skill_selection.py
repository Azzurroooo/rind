"""Deterministic parsing of explicit Skill invocation syntax."""

from __future__ import annotations

from dataclasses import dataclass
import asyncio
import logging
import re

from agent.domain.skills import LoadedSkill, render_skill_content


logger = logging.getLogger(__name__)


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
    """Keep a session's Skill catalog current and snapshot explicitly invoked Skills.

    ``catalog`` is False when the session cannot read files, so it gets no catalog.
    """

    def __init__(self, repository, *, catalog: bool):
        self._repository = repository
        self._catalog = catalog
        self._parser = SkillInvocationParser()

    async def persist_user_input(self, session, text: str) -> list[SkillInvocation]:
        invocations = self._parser.parse(text)
        imports = await session.get_skill_sources() if invocations else {}
        loaded: list[tuple[SkillInvocation, LoadedSkill]] = []
        for invocation in invocations:
            skill = self._repository.load_skill(invocation.name, imports)
            if skill is None:
                if invocation.syntax == "slash":
                    raise ValueError(f"Unknown Skill: {invocation.name}")
                continue
            loaded.append((invocation, skill))

        if loaded:
            await session.persist_user_input(text, meta={
                "kind": "user_prompt",
                "skill_invocations": [
                    {"name": skill.metadata.name, "syntax": invocation.syntax}
                    for invocation, skill in loaded
                ],
            })
        else:
            await session.persist_user_input(text)
        for invocation, skill in loaded:
            await session.persist_message(
                "user",
                render_skill_content(skill),
                meta={
                    "kind": "skill_snapshot",
                    "name": skill.metadata.name,
                    "location": skill.metadata.location,
                    "syntax": invocation.syntax,
                },
            )
        return [invocation for invocation, _skill in loaded]

    async def sync_catalog(self, session) -> None:
        """Refresh the session's Skill catalog; keep the previous one on failure."""
        try:
            skills = self._repository.list_skills(await session.get_skill_sources()) if self._catalog else []
            entries = [skill.to_catalog_entry() for skill in skills if skill.model_invocable]
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Skill catalog scan failed; retaining the previous catalog.", exc_info=True)
            return
        try:
            await session.set_skill_catalog(entries)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Skill catalog persistence failed; retaining the previous catalog.", exc_info=True)
