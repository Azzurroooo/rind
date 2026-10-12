"""Domain objects and deterministic helpers for Rind Skills."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
import json
import re

import yaml


SKILL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
DESCRIPTION_MAX_CHARS = 1024
# Claude and Codex layers a new conversation reads: this folder's, not the user's own.
IMPORT_DEFAULTS = {"claude_user": False, "codex_user": False, "claude_project": True, "codex_project": True}
IMPORT_SOURCES = tuple(IMPORT_DEFAULTS)


@dataclass(frozen=True, slots=True)
class SkillMetadata:
    """One discovered SKILL.md: what the catalog shows and where the model reads it."""

    name: str
    description: str
    location: str
    source: str
    model_invocable: bool = True

    def to_catalog_entry(self) -> dict[str, str]:
        return {
            "name": self.name,
            "description": self.description[:DESCRIPTION_MAX_CHARS],
            "location": self.location,
        }


@dataclass(frozen=True, slots=True)
class LoadedSkill:
    """A Skill whose SKILL.md body was loaded for an explicit invocation."""

    metadata: SkillMetadata
    body: str


def split_frontmatter(text: str) -> tuple[str, str]:
    """Return the raw frontmatter and the body of a SKILL.md document."""
    lines = text.lstrip("﻿").splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError("SKILL.md must start with --- frontmatter.")
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "".join(lines[1:index]), "".join(lines[index + 1:]).strip()
    raise ValueError("SKILL.md frontmatter is missing its closing ---.")


def parse_skill_metadata(text: str, location: str, folder_name: str, source: str) -> tuple[SkillMetadata, str | None]:
    """Parse SKILL.md frontmatter; return the metadata and a warning, if any."""
    raw, _body = split_frontmatter(text)
    fields = _load_frontmatter(raw)
    name = fields.get("name", folder_name)
    if not isinstance(name, str) or not SKILL_NAME_PATTERN.fullmatch(name.strip()):
        raise ValueError(f"invalid name {name!r}; use letters, digits, hyphens and underscores.")
    name = name.strip()
    description = fields.get("description")
    description = " ".join(description.split()) if isinstance(description, str) else ""
    if not description:
        raise ValueError("missing description.")
    metadata = SkillMetadata(
        name=name,
        description=description,
        location=location,
        source=source,
        model_invocable=fields.get("disable-model-invocation") is not True,
    )
    warning = f"name '{name}' differs from its folder '{folder_name}'." if name != folder_name else None
    return metadata, warning


def _load_frontmatter(raw: str) -> dict:
    try:
        fields = yaml.safe_load(raw)
    except yaml.YAMLError:
        try:
            fields = yaml.safe_load(_quote_values_with_colons(raw))
        except yaml.YAMLError as exc:
            raise ValueError(f"invalid YAML frontmatter: {exc.__class__.__name__}.") from exc
    if fields is None:
        return {}
    if not isinstance(fields, dict):
        raise ValueError("frontmatter must be a mapping.")
    return fields


def _quote_values_with_colons(raw: str) -> str:
    """Quote top-level plain values such as `description: Use when: a, b`."""
    lines = []
    for line in raw.splitlines():
        key, separator, value = line.partition(":")
        value = value.strip()
        if separator and key and not key[0].isspace() and ": " in value and value[0] not in "'\"|>[{":
            line = f"{key}: {json.dumps(value, ensure_ascii=False)}"
        lines.append(line)
    return "\n".join(lines)


def render_skill_content(skill: LoadedSkill) -> str:
    """Render the model-facing snapshot of an explicitly invoked Skill."""
    metadata = skill.metadata
    return (
        f'<skill_content name="{escape(metadata.name)}" location="{escape(metadata.location)}">\n'
        f"{skill.body}\n"
        "</skill_content>"
    )


def render_available_skills(entries: list[dict[str, str]], max_chars: int = 8000) -> str:
    """Render a deterministic, metadata-only catalog for model context."""
    normalized = sorted(entries, key=lambda item: item["name"].lower())
    if not normalized:
        return ""

    intro = (
        "<available_skills>\n"
        "Skills are specialized instructions in SKILL.md files. When a task matches a skill's description, "
        "read its file with read_file before acting. Resolve relative paths in a skill against the directory "
        "that contains its SKILL.md."
    )
    footer = "</available_skills>"
    budget = max(0, int(max_chars))
    if len("\n".join((intro, footer))) > budget:
        return ""

    for count in range(len(normalized), -1, -1):
        omitted = len(normalized) - count
        selected = normalized[:count]
        lines = [_render_catalog_line(item, "") for item in selected]
        if omitted:
            lines.append(f"{omitted} additional Skill(s) omitted due to catalog budget.")
        skeleton = "\n".join((intro, *lines, footer))
        if len(skeleton) > budget:
            continue

        description_budget = budget - len(skeleton)
        rendered: list[str] = []
        remaining = len(selected)
        for item in selected:
            share = description_budget // remaining if remaining else 0
            rendered_description = _escaped_prefix(item["description"], share)
            rendered.append(_render_catalog_line(item, rendered_description))
            description_budget -= len(rendered_description)
            remaining -= 1
        if omitted:
            rendered.append(f"{omitted} additional Skill(s) omitted due to catalog budget.")
        return "\n".join((intro, *rendered, footer))
    return ""


def _render_catalog_line(item: dict[str, str], description: str) -> str:
    return f'<skill name="{escape(item["name"])}" location="{escape(item["location"])}">{description}</skill>'


def _escaped_prefix(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    low = 0
    high = len(text)
    best = ""
    while low <= high:
        midpoint = (low + high) // 2
        candidate = escape(text[:midpoint])
        if len(candidate) <= max_chars:
            best = candidate
            low = midpoint + 1
        else:
            high = midpoint - 1
    return best
