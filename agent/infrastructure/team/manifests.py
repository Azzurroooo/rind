"""Team manifest validation and YAML encoding."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


AITEAM_DIR = ".aiteam"
AGENT_MANIFEST = "agent.yaml"
PROJECT_MANIFEST = "project.yaml"


def project_manifest(project_id: str, name: str, main_agent_id: str) -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Project",
        "metadata": {"id": project_id, "name": name},
        "spec": {
            "main_agent": main_agent_id,
            "shared_root": "../shared",
            "agents_root": "../agents",
        },
    }


def agent_manifest(agent_id: str, name: str, description: str = "Default Team entry agent.") -> dict[str, Any]:
    return {
        "api_version": "aiteam/v1",
        "kind": "Agent",
        "metadata": {
            "id": agent_id,
            "name": name,
            "description": description,
        },
        "spec": {
            "prompts": {"system": ["./prompts/system.md"]},
            "skills": {"enabled": []},
            "workflows": {"available": []},
            "memory": {"root": "../memory", "scope": "agent_project"},
            "filesystem": {
                "writable": ["../work", "../outputs", "../memory", "../../../shared"],
                "readonly": ["..", "../../../shared"],
            },
        },
    }


def manifest_paths(spec: dict[str, Any], path: tuple[str, ...], base: Path, *, require_files: bool = True) -> list[Path]:
    paths = [resolve_manifest_path(base, item) for item in text_list(nested(spec, *path))]
    if require_files:
        missing = [path for path in paths if not path.is_file()]
        if missing:
            raise ValueError(f"Manifest references missing file: {missing[0]}")
    return paths


def nested(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def resolve_manifest_path(base: Path, value: object) -> Path:
    raw = clean_text(value, "path")
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve()


def write_yaml(path: Path, data: dict[str, Any]) -> None:
    write_new_text(path, _dump_yaml(data))


def read_yaml(path: Path) -> Any:
    if not path.is_file():
        raise ValueError(f"Missing file: {path}")
    text = path.read_text(encoding="utf-8")
    stripped = text.strip()
    if not stripped:
        return {}
    if stripped.startswith("{"):
        return json.loads(stripped)
    lines = _yaml_lines(text)
    if not lines:
        return {}
    value, index = _parse_yaml_block(lines, 0, lines[0][0])
    if index != len(lines):
        raise ValueError(f"Unsupported YAML structure: {path}")
    return value


def _yaml_lines(text: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, raw.strip()))
    return lines


def _parse_yaml_block(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[Any, int]:
    if lines[index][1].startswith("- "):
        return _parse_yaml_list(lines, index, indent)
    return _parse_yaml_map(lines, index, indent)


def _parse_yaml_list(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[list[Any], int]:
    result: list[Any] = []
    while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- "):
        item = lines[index][1][2:].strip()
        index += 1
        if not item:
            value, index = _parse_yaml_block(lines, index, indent + 2)
            result.append(value)
            continue
        if ":" in item and not item.startswith(('"', "'")):
            key, value = _split_yaml_pair(item)
            mapping = {key: _parse_scalar(value)}
            while index < len(lines) and lines[index][0] == indent + 2 and not lines[index][1].startswith("- "):
                child_key, child_value = _split_yaml_pair(lines[index][1])
                index += 1
                if child_value == "" and index < len(lines) and lines[index][0] > indent + 2:
                    parsed, index = _parse_yaml_block(lines, index, lines[index][0])
                    mapping[child_key] = parsed
                else:
                    mapping[child_key] = _parse_scalar(child_value)
            result.append(mapping)
            continue
        result.append(_parse_scalar(item))
    return result, index


def _parse_yaml_map(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while index < len(lines) and lines[index][0] == indent and not lines[index][1].startswith("- "):
        key, value = _split_yaml_pair(lines[index][1])
        index += 1
        if value == "" and index < len(lines) and lines[index][0] > indent:
            parsed, index = _parse_yaml_block(lines, index, lines[index][0])
            result[key] = parsed
        else:
            result[key] = _parse_scalar(value)
    return result, index


def _split_yaml_pair(text: str) -> tuple[str, str]:
    if ":" not in text:
        raise ValueError(f"Invalid YAML line: {text}")
    key, value = text.split(":", 1)
    key = key.strip()
    if not key:
        raise ValueError(f"Invalid YAML key: {text}")
    return key, value.strip()


def _parse_scalar(value: str) -> Any:
    if value == "":
        return ""
    if value == "[]":
        return []
    if value == "{}":
        return {}
    if value in {"null", "~"}:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def _dump_yaml(data: Any, indent: int = 0) -> str:
    lines = _dump_yaml_lines(data, indent)
    return "\n".join(lines) + "\n"


def _dump_yaml_lines(data: Any, indent: int) -> list[str]:
    prefix = " " * indent
    if isinstance(data, dict):
        lines: list[str] = []
        for key, value in data.items():
            if isinstance(value, (dict, list)) and value:
                lines.append(f"{prefix}{key}:")
                lines.extend(_dump_yaml_lines(value, indent + 2))
            else:
                lines.append(f"{prefix}{key}: {_format_scalar(value)}")
        return lines
    if isinstance(data, list):
        if not data:
            return [f"{prefix}[]"]
        lines = []
        for item in data:
            if isinstance(item, dict):
                if not item:
                    lines.append(f"{prefix}- {{}}")
                    continue
                first = True
                for key, value in item.items():
                    marker = "- " if first else "  "
                    if isinstance(value, (dict, list)) and value:
                        lines.append(f"{prefix}{marker}{key}:")
                        lines.extend(_dump_yaml_lines(value, indent + 4))
                    else:
                        lines.append(f"{prefix}{marker}{key}: {_format_scalar(value)}")
                    first = False
            elif isinstance(item, list):
                lines.append(f"{prefix}-")
                lines.extend(_dump_yaml_lines(item, indent + 2))
            else:
                lines.append(f"{prefix}- {_format_scalar(item)}")
        return lines
    return [f"{prefix}{_format_scalar(data)}"]


def _format_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value == []:
        return "[]"
    if value == {}:
        return "{}"
    text = str(value)
    if text == "" or text.strip() != text or any(char in text for char in ("#", "\n")):
        return json.dumps(text, ensure_ascii=False)
    return text


def validate_id(value: object, field: str) -> str:
    text = clean_text(value, field)
    if any(char in text for char in ("/", "\\", ":")) or text in {".", ".."}:
        raise ValueError(f"Invalid {field}: {text}")
    return text


def clean_text(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required.")
    return text


def text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Expected a list.")
    return [clean_text(item, "list item") for item in value]


def require_mapping(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(message)
    return value


def write_new_text(path: Path, text: str) -> None:
    if path.exists():
        raise ValueError(f"Refusing to overwrite existing file: {path}")
    path.write_text(text, encoding="utf-8")
