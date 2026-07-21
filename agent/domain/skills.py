"""Domain objects and helpers for Rind skills."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class Skill:
    """Parsed skill instructions available for model context injection."""

    name: str
    description: str
    body: str
    path: str
    triggers: list[str] = field(default_factory=list)
    source: str = ""
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class SkillMatch:
    """Selected skill plus the reason it was activated."""

    skill: Skill
    reason: str
    score: int = 0


def parse_skill_markdown(text: str, path: str, fallback_name: str, source: str) -> Skill:
    """Parse a SKILL.md file using a narrow frontmatter subset."""
    warnings: list[str] = []
    metadata: dict[str, object] = {}
    body = text

    if text.startswith("---"):
        try:
            end_index = text.find("\n---", 3)
            if end_index == -1:
                warnings.append("Frontmatter start found without closing marker.")
            else:
                raw_meta = text[3:end_index].strip()
                body = text[end_index + len("\n---") :].lstrip("\r\n")
                metadata = _parse_frontmatter(raw_meta)
        except Exception as exc:
            warnings.append(f"Frontmatter parse failed: {exc}")
            metadata = {}
            body = text

    name = str(metadata.get("name") or fallback_name).strip() or fallback_name
    description = str(metadata.get("description") or "").strip()
    triggers_value = metadata.get("triggers")
    triggers = [str(item).strip() for item in triggers_value] if isinstance(triggers_value, list) else []
    triggers = [item for item in triggers if item]

    if not description:
        description = _fallback_description(body)
        if not description:
            description = f"Skill instructions for {name}."
            warnings.append("Missing description; generated fallback description.")

    if name.lower() != fallback_name.lower():
        warnings.append(f"Skill name '{name}' does not match directory name '{fallback_name}'.")

    return Skill(
        name=name,
        description=description,
        body=body.strip(),
        path=path,
        triggers=triggers,
        source=source,
        warnings=warnings,
    )


def render_active_skill_instructions(matches: list[SkillMatch], max_body_chars: int = 6000) -> str:
    """Render selected skill bodies with a total character budget."""
    lines = ["Active skill instructions:"]
    remaining = max(0, int(max_body_chars))
    truncation = "\n...(skill instructions truncated due to context budget)..."

    for match in matches:
        skill = match.skill
        header = f'\n<skill name="{skill.name}" reason="{match.reason}" source="{skill.source}">\n'
        footer = "\n</skill>"
        body_budget = remaining - len(header) - len(footer)
        if body_budget <= 0:
            lines.append(truncation.strip())
            break
        body = skill.body
        if len(body) > body_budget:
            body = body[: max(0, body_budget - len(truncation))].rstrip() + truncation
            lines.append(header + body + footer)
            break
        lines.append(header + body + footer)
        remaining -= len(header) + len(body) + len(footer)

    return "\n".join(lines)


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


def _fallback_description(body: str) -> str:
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        return _truncate(" ".join(line.split()), 200)
    return ""


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."
