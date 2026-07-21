"""Structural constraints for the agent package."""

from __future__ import annotations

import ast
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "agent"


def _absolute_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imports.add(node.module)
    return imports


def _assert_layer_excludes(layer: str, forbidden: tuple[str, ...]) -> None:
    violations: list[str] = []
    for path in (AGENT_ROOT / layer).rglob("*.py"):
        for imported in _absolute_imports(path):
            if imported.startswith(forbidden):
                violations.append(f"{path.relative_to(PROJECT_ROOT)} -> {imported}")
    assert not violations, "Invalid layer dependencies:\n" + "\n".join(sorted(violations))


def test_layer_dependencies_point_inward() -> None:
    _assert_layer_excludes(
        "domain",
        ("agent.application", "agent.infrastructure", "agent.interfaces", "agent.bootstrap"),
    )
    _assert_layer_excludes(
        "application",
        ("agent.infrastructure", "agent.interfaces", "agent.bootstrap"),
    )
    _assert_layer_excludes("infrastructure", ("agent.interfaces", "agent.bootstrap"))


def test_legacy_structure_is_removed() -> None:
    legacy_paths = (
        "application/services",
        "application/tool_executor.py",
        "application/runtime/cancellation.py",
        "infrastructure/plans",
        "infrastructure/tools/impl",
    )
    assert not [path for path in legacy_paths if (AGENT_ROOT / path).exists()]
