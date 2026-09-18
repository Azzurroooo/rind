"""Structural constraints for the agent package."""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "agent"

_SESSION_PRIVATE_FIELDS = {"_session_paths", "_session_root", "_session_dir"}


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
    _assert_path_excludes(AGENT_ROOT / layer, forbidden)


def _assert_path_excludes(root: Path, forbidden: tuple[str, ...]) -> None:
    violations: list[str] = []
    for path in root.rglob("*.py"):
        for imported in _absolute_imports(path):
            if imported.startswith(forbidden):
                violations.append(f"{path.relative_to(PROJECT_ROOT)} -> {imported}")
    assert not violations, "Invalid layer dependencies:\n" + "\n".join(sorted(violations))


def test_layer_dependencies_point_inward() -> None:
    _assert_layer_excludes(
        "domain",
        ("agent.application", "agent.infrastructure", "agent.bootstrap"),
    )
    _assert_layer_excludes(
        "application",
        ("agent.infrastructure", "agent.bootstrap"),
    )
    _assert_layer_excludes("infrastructure", ("agent.bootstrap",))


def test_runtime_core_does_not_depend_on_server_or_adapters() -> None:
    _assert_path_excludes(
        AGENT_ROOT / "runtime" / "core",
        ("agent.infrastructure", "agent.bootstrap", "agent.runtime.server"),
    )


def test_runtime_server_does_not_read_private_session_fields() -> None:
    violations: list[str] = []
    for path in (AGENT_ROOT / "runtime" / "server").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative = path.relative_to(PROJECT_ROOT).as_posix()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in _SESSION_PRIVATE_FIELDS:
                violations.append(f"{relative} -> {node.attr}")
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "getattr" or len(node.args) < 2:
                continue
            field = node.args[1]
            if isinstance(field, ast.Constant) and field.value in _SESSION_PRIVATE_FIELDS:
                violations.append(f"{relative} -> {field.value}")
    assert not violations, "Runtime Server reads private session fields:\n" + "\n".join(sorted(violations))


def test_legacy_structure_is_removed() -> None:
    legacy_paths = (
        "application/services",
        "application/tool_executor.py",
        "runtime/core/cancellation.py",
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
    entrypoints = (AGENT_ROOT / "runtime" / "server" / "worker.py",)
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

    app_server = (AGENT_ROOT / "runtime" / "server" / "app_server.py").read_text(encoding="utf-8")
    assert "RuntimeWorker" in app_server
    assert "build_agent_container" not in app_server


def test_main_delegates_to_runtime_server() -> None:
    source = (PROJECT_ROOT / "main.py").read_text(encoding="utf-8")
    assert "agent.runtime.server.app_server" in source
    assert "build_agent_container" not in source


def test_python_module_dependencies_have_no_cycles() -> None:
    paths = [*AGENT_ROOT.rglob("*.py"), *(PROJECT_ROOT / "gateway").rglob("*.py")]
    modules = {
        ".".join(path.relative_to(PROJECT_ROOT).with_suffix("").parts).removesuffix(".__init__"): path
        for path in paths
    }
    edges = {name: set() for name in modules}
    for name, path in modules.items():
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            imports = []
            if isinstance(node, ast.Import):
                imports = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    base = importlib.util.resolve_name("." * node.level + base, package)
                imports = [base, *(f"{base}.{alias.name}" for alias in node.names)]
            edges[name].update(target for target in imports if target in modules and target != name)

    visited = set()
    visiting = []

    def visit(name):
        assert name not in visiting, "Dependency cycle: " + " -> ".join([*visiting, name])
        if name in visited:
            return
        visiting.append(name)
        for target in sorted(edges[name]):
            visit(target)
        visiting.pop()
        visited.add(name)

    for name in sorted(modules):
        visit(name)
