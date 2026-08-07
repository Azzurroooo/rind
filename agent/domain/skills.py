"""Domain objects and deterministic helpers for Rind Skills."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path
import re


SKILL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True, slots=True)
class SkillMetadata:
    """Metadata exposed in the session Skill catalog."""

    name: str
    description: str
    path: str
    scope: str

    def to_catalog_entry(self) -> dict[str, str]:
        return {
            "name": self.name,
            "description": self.description,
            "scope": self.scope,
        }


@dataclass(frozen=True, slots=True)
class LoadedSkill:
    """A Skill whose full SKILL.md body has been explicitly loaded."""

    metadata: SkillMetadata
    body: str

    @property
    def name(self) -> str:
        return self.metadata.name

    @property
    def description(self) -> str:
        return self.metadata.description

    @property
    def path(self) -> str:
        return self.metadata.path

    @property
    def scope(self) -> str:
        return self.metadata.scope


def parse_skill_metadata(
    text: str,
    path: str,
    fallback_name: str,
    scope: str,
) -> SkillMetadata:
    """Parse only SKILL.md frontmatter without reading or validating the body."""
    metadata = _parse_document_frontmatter(text)
    raw_name = metadata.get("name")
    raw_description = metadata.get("description")
    if not isinstance(raw_name, str) or not isinstance(raw_description, str):
        raise ValueError("SKILL.md frontmatter name and description must be strings.")
    name = raw_name.strip()
    description = raw_description.strip()
    if not name:
        raise ValueError("SKILL.md frontmatter requires name.")
    if not description:
        raise ValueError("SKILL.md frontmatter requires description.")
    if name != fallback_name:
        raise ValueError(f"Skill name '{name}' does not match directory name '{fallback_name}'.")
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise ValueError("Skill name contains unsupported characters.")
    if "\n" in description or "\r" in description:
        raise ValueError("Skill description must be a single line.")
    return SkillMetadata(name=name, description=description, path=str(Path(path)), scope=scope)


def parse_skill_markdown(
    text: str,
    path: str,
    fallback_name: str,
    scope: str,
) -> LoadedSkill:
    """Parse and validate a complete SKILL.md document."""
    metadata = parse_skill_metadata(text, path, fallback_name, scope)
    _frontmatter_end = _find_frontmatter_end(text)
    body = text[_frontmatter_end:].lstrip("\r\n").strip()
    if not body:
        raise ValueError("SKILL.md body cannot be empty.")
    return LoadedSkill(metadata=metadata, body=body)


def render_skill_content(skill: LoadedSkill) -> str:
    """Render the stable model-facing representation of a loaded Skill."""
    metadata = skill.metadata
    base_directory = str(Path(metadata.path).parent)
    return "\n".join(
        [
            f'<skill_content name="{escape(metadata.name)}" scope="{escape(metadata.scope)}">',
            f"<path>{escape(metadata.path)}</path>",
            skill.body,
            f"<base_directory>{escape(base_directory)}</base_directory>",
            "</skill_content>",
        ]
    )


def render_available_skills(entries: list[dict[str, str]], max_chars: int = 8000) -> str:
    """Render a deterministic, metadata-only catalog for model context."""
    normalized = sorted(
        (
            {
                "name": str(item.get("name") or "").strip(),
                "description": str(item.get("description") or "").strip(),
                "scope": str(item.get("scope") or "").strip(),
            }
            for item in entries
            if isinstance(item, dict)
            and str(item.get("name") or "").strip()
            and str(item.get("description") or "").strip()
            and str(item.get("scope") or "").strip()
        ),
        key=lambda item: item["name"].lower(),
    )
    if not normalized:
        return ""

    intro = "<available_skills>\nUse the skill tool to load a Skill when the task matches its description."
    footer = "</available_skills>"
    budget = max(0, int(max_chars))
    if len("\n".join((intro, footer))) > budget:
        return ""

    for count in range(len(normalized), -1, -1):
        omitted = len(normalized) - count
        selected = normalized[:count]
        lines = [_render_catalog_line(item, "") for item in selected]
        if omitted:
            lines.append(f"- {omitted} additional Skill(s) omitted due to catalog budget.")
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
            rendered.append(f"- {omitted} additional Skill(s) omitted due to catalog budget.")
        return "\n".join((intro, *rendered, footer))
    return ""


def _render_catalog_line(item: dict[str, str], description: str) -> str:
    return (
        f'- <skill name="{escape(item["name"])}" scope="{escape(item["scope"])}">'
        f"{description}</skill>"
    )


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


def _parse_document_frontmatter(text: str) -> dict[str, object]:
    if not isinstance(text, str) or not text.startswith("---") or (text.splitlines() and text.splitlines()[0].strip() != "---"):
        raise ValueError("SKILL.md must start with frontmatter.")
    marker_start, _marker_end = _frontmatter_bounds(text)
    raw_meta = text[3:marker_start].strip()
    return _parse_frontmatter(raw_meta)


def _find_frontmatter_end(text: str, include_marker: bool = False) -> int:
    _marker_start, marker_end = _frontmatter_bounds(text)
    return marker_end


def _frontmatter_bounds(text: str) -> tuple[int, int]:
    marker = re.search(r"\r?\n---[ \t]*(?:\r?\n|$)", text[3:])
    if marker is None:
        raise ValueError("SKILL.md frontmatter is missing its closing marker.")
    return 3 + marker.start(), 3 + marker.end()


def _parse_frontmatter(raw_meta: str) -> dict[str, object]:
    metadata: dict[str, object] = {}
    current_list_key: str | None = None
    for raw_line in raw_meta.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if current_list_key and line.startswith("- "):
            value = _clean_scalar(line[2:])
            if value:
                metadata.setdefault(current_list_key, []).append(value)
            continue
        current_list_key = None
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value:
            metadata[key] = _clean_scalar(value)
        else:
            metadata[key] = []
            current_list_key = key
    return metadata


def _clean_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value
