"""Skill loading and authoring tools."""

from __future__ import annotations

from pathlib import Path

from agent.domain import render_skill_content, tool_error, tool_ok
from agent.domain.skills import SKILL_NAME_PATTERN
from agent.infrastructure.skills import SkillRepository
from agent.infrastructure.tools.spec import ToolSpec


def skill(name: str, _repository: SkillRepository | None = None) -> str:
    """Load one effective Skill by name."""
    normalized_name = _normalize_name(name)
    if not normalized_name:
        return tool_error("skill", "Invalid Skill name.", "InvalidSkillName", meta={"name": name})
    repository = _repository if _repository is not None else SkillRepository()
    try:
        loaded = repository.load_skill(normalized_name)
    except Exception as exc:
        return tool_error("skill", f"Failed to load Skill: {exc}", type(exc).__name__)
    if loaded is None:
        return tool_error("skill", f"Skill not found: {normalized_name}", "SkillNotFound", meta={"name": normalized_name})
    return tool_ok(
        "skill",
        {
            "name": loaded.name,
            "scope": loaded.scope,
            "path": loaded.path,
            "base_directory": str(Path(loaded.path).parent),
            "content": render_skill_content(loaded),
        },
    )


def skill_create(
    name: str,
    description: str,
    body: str,
    scope: str = "project",
    overwrite: bool = False,
    _repository: SkillRepository | None = None,
) -> str:
    """Create a standard Rind SKILL.md in one explicit scope."""
    normalized_name = _normalize_name(name)
    if not normalized_name:
        return tool_error(
            "skill_create",
            "Invalid Skill name. Use only letters, numbers, underscores, and hyphens.",
            "InvalidSkillName",
            meta={"name": name},
        )
    normalized_scope = str(scope or "").strip().lower()
    if normalized_scope not in {"project", "user", "agent"}:
        return tool_error(
            "skill_create",
            "Invalid scope. Expected 'project', 'user', or 'agent'.",
            "InvalidScope",
            meta={"scope": scope},
        )
    normalized_description = str(description or "").strip()
    if not normalized_description:
        return tool_error("skill_create", "description cannot be empty.", "ValidationError")
    if "\n" in normalized_description or "\r" in normalized_description:
        return tool_error("skill_create", "description must be a single line.", "ValidationError")
    normalized_body = str(body or "").strip()
    if not normalized_body:
        return tool_error("skill_create", "body cannot be empty.", "ValidationError")

    repository = _repository if _repository is not None else SkillRepository()
    try:
        root = repository.skill_root(normalized_scope)
    except ValueError as exc:
        return tool_error("skill_create", str(exc), "InvalidScope", meta={"scope": normalized_scope})
    except Exception as exc:
        return tool_error("skill_create", f"Failed to resolve Skill scope: {exc}", type(exc).__name__)

    root = root.resolve()
    skill_dir = root / normalized_name
    if skill_dir.is_symlink():
        return tool_error("skill_create", f"Skill path is a symbolic link: {skill_dir}", "InvalidSkillPath")
    skill_dir = skill_dir.resolve()
    try:
        skill_dir.relative_to(root)
    except ValueError:
        return tool_error("skill_create", "Skill path escapes its scope root.", "InvalidSkillPath")
    skill_file = skill_dir / "SKILL.md"
    if skill_file.is_symlink():
        return tool_error("skill_create", f"SKILL.md is a symbolic link: {skill_file}", "InvalidSkillPath")
    if skill_file.exists() and not overwrite:
        return tool_error(
            "skill_create",
            f"Skill already exists: {skill_file}",
            "SkillAlreadyExists",
            meta={"path": str(skill_file), "scope": normalized_scope},
        )
    try:
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_file.write_text(
            _render_skill_markdown(normalized_name, normalized_description, normalized_body),
            encoding="utf-8",
        )
    except Exception as exc:
        return tool_error("skill_create", f"Failed to create Skill: {exc}", type(exc).__name__)
    return tool_ok(
        "skill_create",
        {
            "path": str(skill_file),
            "scope": normalized_scope,
            "name": normalized_name,
            "overwritten": bool(overwrite),
        },
    )


def build_skill_tool_specs(repository: SkillRepository | None = None) -> tuple[ToolSpec, ...]:
    if repository is None:
        return TOOL_SPECS
    return _build_skill_tool_specs(repository)


def _build_skill_tool_specs(repository: SkillRepository | None) -> tuple[ToolSpec, ...]:
    def load_skill(name: str) -> str:
        return skill(name, _repository=repository)

    def create_skill(
        name: str,
        description: str,
        body: str,
        scope: str = "project",
        overwrite: bool = False,
    ) -> str:
        return skill_create(
            name=name,
            description=description,
            body=body,
            scope=scope,
            overwrite=overwrite,
            _repository=repository,
        )

    return (
        ToolSpec(
            name="skill",
            handler=load_skill,
            description="Load a specialized Skill from the available Skill catalog when its workflow matches the current task.",
            param_descriptions={"name": "Skill 名称，必须匹配当前可用 Skill 清单中的名称。"},
        ),
        ToolSpec(
            name="skill_create",
            handler=create_skill,
            description="创建格式正确的 Rind Skill。Skill 正文只会在显式加载时进入上下文。",
            param_descriptions={
                "name": "Skill 名称。只能包含字母、数字、下划线和连字符。",
                "description": "Skill 的单行摘要，用于 session Skill catalog。",
                "body": "SKILL.md 正文指令内容。",
                "scope": {
                    "description": "写入范围。agent 仅在当前 Agent workspace 中可用。默认 project。",
                    "enum": ["project", "user", "agent"],
                },
                "overwrite": "是否覆盖已存在的 SKILL.md。默认 False。",
            },
        ),
    )


def _normalize_name(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or normalized in {".", ".."} or not SKILL_NAME_PATTERN.fullmatch(normalized):
        return ""
    return normalized


def _render_skill_markdown(name: str, description: str, body: str) -> str:
    return "\n".join(
        [
            "---",
            f"name: {_quote_yaml_string(name)}",
            f"description: {_quote_yaml_string(description)}",
            "---",
            "",
            body.rstrip(),
            "",
        ]
    )


def _quote_yaml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


TOOL_SPECS = _build_skill_tool_specs(None)
