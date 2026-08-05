"""Structural constraints for the agent package."""

from __future__ import annotations

import ast
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "agent"
INTERFACES_ROOT = AGENT_ROOT / "interfaces"

_SESSION_PRIVATE_FIELDS = {"_session_paths", "_session_root", "_session_dir"}

# Temporary baselines. Stage 2 will remove these entries as the boundary leaks
# are fixed; adding a new entry should fail this test instead of extending it.
_KNOWN_INTERFACE_INFRASTRUCTURE_IMPORTS = {
    "agent/interfaces/api/routes_session.py -> agent.infrastructure.paths",
    "agent/interfaces/runtime_server/stdio.py -> agent.infrastructure.config",
    "agent/interfaces/runtime_server/stdio.py -> agent.infrastructure.paths",
    "agent/interfaces/runtime_server/stdio.py -> agent.infrastructure.tools.builtin.shell.tool",
    "agent/interfaces/cli/commands/diagnostics.py -> agent.infrastructure.config",
    "agent/interfaces/cli/commands/diagnostics.py -> agent.infrastructure.config.settings_loader",
    "agent/interfaces/cli/commands/diagnostics.py -> agent.infrastructure.persistence.jsonl_session_store",
    "agent/interfaces/cli/commands/features/config.py -> agent.infrastructure.config",
    "agent/interfaces/cli/commands/features/init.py -> agent.infrastructure.rind_docs",
    "agent/interfaces/cli/commands/features/model.py -> agent.infrastructure.config",
    "agent/interfaces/cli/commands/features/plan.py -> agent.infrastructure.planning.store",
    "agent/interfaces/cli/commands/features/plan.py -> agent.infrastructure.planning.summary",
    "agent/interfaces/cli/commands/features/skill.py -> agent.infrastructure.skills.repository",
    "agent/interfaces/cli/commands/model_control.py -> agent.infrastructure.config",
}

_KNOWN_INTERFACE_PRIVATE_FIELD_READS = {
    "agent/interfaces/cli/chat_cli.py -> _session_paths",
    "agent/interfaces/cli/chat_cli.py -> _session_root",
    "agent/interfaces/cli/commands/diagnostics.py -> _session_root",
    "agent/interfaces/cli/commands/diagnostics.py -> _session_dir",
    "agent/interfaces/cli/commands/features/draft.py -> _session_paths",
    "agent/interfaces/cli/commands/features/draft.py -> _session_root",
}


def _absolute_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imports.add(node.module)
    return imports


def _interface_infrastructure_imports() -> set[str]:
    imports: set[str] = set()
    for path in INTERFACES_ROOT.rglob("*.py"):
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        imports.update(
            f"{relative} -> {imported}"
            for imported in _absolute_imports(path)
            if imported.startswith("agent.infrastructure")
        )
    return imports


def _interface_private_field_reads() -> set[str]:
    reads: set[str] = set()
    for path in INTERFACES_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in _SESSION_PRIVATE_FIELDS:
                reads.add(f"{relative} -> {node.attr}")
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "getattr" or len(node.args) < 2:
                continue
            field = node.args[1]
            if isinstance(field, ast.Constant) and field.value in _SESSION_PRIVATE_FIELDS:
                reads.add(f"{relative} -> {field.value}")
    return reads


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


def test_interface_infrastructure_imports_do_not_grow() -> None:
    current = _interface_infrastructure_imports()
    unexpected = current - _KNOWN_INTERFACE_INFRASTRUCTURE_IMPORTS
    assert not unexpected, "New interface-to-infrastructure imports:\n" + "\n".join(sorted(unexpected))


def test_interface_private_session_reads_do_not_grow() -> None:
    current = _interface_private_field_reads()
    unexpected = current - _KNOWN_INTERFACE_PRIVATE_FIELD_READS
    assert not unexpected, "New interface private session reads:\n" + "\n".join(sorted(unexpected))


def test_legacy_structure_is_removed() -> None:
    legacy_paths = (
        "application/services",
        "application/tool_executor.py",
        "application/runtime/cancellation.py",
        "infrastructure/plans",
        "infrastructure/tools/impl",
    )
    assert not [path for path in legacy_paths if (AGENT_ROOT / path).exists()]


def test_runtime_dependencies_type_is_not_reintroduced() -> None:
    definitions: list[str] = []
    for path in AGENT_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "RuntimeDependencies":
                definitions.append(str(path.relative_to(PROJECT_ROOT)))
    assert not definitions, f"RuntimeDependencies duplicates AgentContainer: {definitions}"


def test_runtime_entrypoints_use_the_shared_composition_root() -> None:
    entrypoints = (
        PROJECT_ROOT / "main.py",
        AGENT_ROOT / "interfaces" / "runtime_server" / "stdio.py",
        AGENT_ROOT / "interfaces" / "api" / "main.py",
    )
    missing: list[str] = []
    for path in entrypoints:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        calls_builder = any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "build_agent_container"
            for node in ast.walk(tree)
        )
        if not calls_builder:
            missing.append(str(path.relative_to(PROJECT_ROOT)))
    assert not missing, f"Runtime entrypoints bypass composition root: {missing}"
