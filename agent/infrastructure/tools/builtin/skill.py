"""Skill authoring tools."""

from __future__ import annotations

from pathlib import Path
import re

from agent.domain import tool_error, tool_ok
from agent.infrastructure.paths import resolve_rind_home, resolve_project_root
from agent.infrastructure.tools.spec import ToolSpec

_SKILL_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def skill_create(
    name: str,
    description: str,
    body: str,
    triggers: list[str] | None = None,
    scope: str = "project",
    overwrite: bool = False,
) -> str:
    """Create a well-formed Rind SKILL.md in the project or user skill directory."""
    try:
        normalized_name = name.strip() if isinstance(name, str) else ""
        if not normalized_name or normalized_name in {".", ".."} or not _SKILL_NAME_PATTERN.fullmatch(normalized_name):
            return tool_error(
                "skill_create",
                "Invalid skill name. Use only letters, numbers, underscores, and hyphens.",
                "InvalidSkillName",
                meta={"name": name},
            )

        normalized_scope = scope.strip().lower() if isinstance(scope, str) else ""
        if normalized_scope not in {"project", "user"}:
            return tool_error(
                "skill_create",
                "Invalid scope. Expected 'project' or 'user'.",
                "InvalidScope",
                meta={"scope": scope},
            )

        normalized_description = description.strip() if isinstance(description, str) else ""
        if not normalized_description:
            return tool_error("skill_create", "description cannot be empty.", "ValidationError")
        if "\n" in normalized_description or "\r" in normalized_description:
            return tool_error("skill_create", "description must be a single line.", "ValidationError")

        normalized_body = body.strip() if isinstance(body, str) else ""
        if not normalized_body:
            return tool_error("skill_create", "body cannot be empty.", "ValidationError")

        normalized_triggers = _normalize_triggers(triggers)
        root = (
            resolve_project_root() / ".rind" / "skills"
            if normalized_scope == "project"
            else resolve_rind_home() / "skills"
        )
        skill_dir = (root / normalized_name).resolve()
        skill_file = skill_dir / "SKILL.md"

        if skill_file.exists() and not overwrite:
            return tool_error(
                "skill_create",
                f"Skill already exists: {skill_file}",
                "SkillAlreadyExists",
                meta={"path": str(skill_file), "scope": normalized_scope},
            )

        skill_dir.mkdir(parents=True, exist_ok=True)
        content = _render_skill_markdown(
            name=normalized_name,
            description=normalized_description,
            body=normalized_body,
            triggers=normalized_triggers,
        )
        skill_file.write_text(content, encoding="utf-8")

        return tool_ok(
            "skill_create",
            {
                "path": str(skill_file),
                "scope": normalized_scope,
                "name": normalized_name,
                "overwritten": bool(overwrite),
                "triggers": normalized_triggers,
            },
        )
    except Exception as exc:
        return tool_error("skill_create", f"Failed to create skill: {exc}", type(exc).__name__)


def _normalize_triggers(triggers: list[str] | None) -> list[str]:
    if triggers is None:
        return []
    if not isinstance(triggers, list):
        raise ValueError("triggers must be a list of strings.")

    normalized: list[str] = []
    seen: set[str] = set()
    for item in triggers:
        value = str(item).strip()
        if not value:
            continue
        if "\n" in value or "\r" in value:
            raise ValueError("trigger entries must be single-line strings.")
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(value)
    return normalized


def _render_skill_markdown(name: str, description: str, body: str, triggers: list[str]) -> str:
    lines = [
        "---",
        f"name: {_quote_yaml_string(name)}",
        f"description: {_quote_yaml_string(description)}",
    ]
    if triggers:
        lines.append("triggers:")
        lines.extend(f"  - {_quote_yaml_string(trigger)}" for trigger in triggers)
    else:
        lines.append("triggers: []")
    lines.extend(["---", "", body.rstrip(), ""])
    return "\n".join(lines)


def _quote_yaml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


TOOL_SPECS = (
    ToolSpec(
        name="skill_create",
        handler=skill_create,
        description="创建格式正确的 Rind Skill。自动写入当前目录 .rind/skills/<name>/SKILL.md 或用户级 RIND_HOME/skills/<name>/SKILL.md，并生成稳定的 frontmatter。",
        param_descriptions={
            "name": "Skill 名称。只能包含字母、数字、下划线和连字符。",
            "description": "Skill 的简短说明，写入 frontmatter，用于上下文中的 skill index。",
            "body": "SKILL.md 正文指令内容。",
            "triggers": "可选触发短语列表。为空时写入 triggers: []。",
            "scope": {"description": "写入范围：project 写到当前项目，user 写到用户目录。默认 project。", "enum": ["project", "user"]},
            "overwrite": "是否覆盖已存在的 SKILL.md。默认 False。",
        },
    ),
)
