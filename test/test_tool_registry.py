"""Tool catalog and registry dispatch tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.infrastructure.tools import DefaultToolRegistry, ToolSpec
from agent.infrastructure.tools.builtin import TOOL_SPECS, build_builtin_tool_specs


def _spec(name: str, handler) -> ToolSpec:
    return ToolSpec(name=name, handler=handler, description=f"{name} test tool.")


@pytest.mark.asyncio
async def test_registry_dispatches_sync_and_async_tools() -> None:
    def sync_tool(value: str) -> str:
        return f"sync:{value}"

    async def async_tool(value: str) -> str:
        return f"async:{value}"

    registry = DefaultToolRegistry((_spec("sync_tool", sync_tool), _spec("async_tool", async_tool)))

    assert registry.is_async("sync_tool") is False
    assert registry.call("sync_tool", {"value": "one"}) == "sync:one"
    assert registry.is_async("async_tool") is True
    assert await registry.call_async("async_tool", {"value": "two"}) == "async:two"


def test_registry_filters_undeclared_private_args_and_forwards_declared_token() -> None:
    def public_tool(value: str) -> str:
        return value

    def token_tool(value: str, _cancellation_token=None):
        return _cancellation_token

    marker = object()
    registry = DefaultToolRegistry(
        (_spec("public_tool", public_tool), _spec("token_tool", token_tool))
    )

    assert registry.call("public_tool", {"value": "ok", "_cancellation_token": marker}) == "ok"
    assert registry.call("token_tool", {"value": "ok", "_cancellation_token": marker}) is marker


def test_registry_forwards_all_arguments_to_kwargs_handler() -> None:
    def kwargs_tool(**kwargs):
        return kwargs

    registry = DefaultToolRegistry((_spec("kwargs_tool", kwargs_tool),))

    assert registry.call("kwargs_tool", {"value": "ok", "_cancellation_token": "token"}) == {
        "value": "ok",
        "_cancellation_token": "token",
    }


def test_explicitly_empty_catalog_stays_empty() -> None:
    registry = DefaultToolRegistry(())

    assert registry.schemas == []
    assert registry.has("read_file") is False


def test_duplicate_tool_names_are_rejected() -> None:
    def first() -> str:
        return "first"

    def second() -> str:
        return "second"

    with pytest.raises(ValueError, match="Duplicate tool name: duplicate"):
        DefaultToolRegistry((_spec("duplicate", first), _spec("duplicate", second)))


def test_shell_schemas_hide_runtime_session_context() -> None:
    registry = DefaultToolRegistry()
    schemas = {schema["function"]["name"]: schema for schema in registry.schemas}

    for name in ("bash", "bash_output"):
        properties = schemas[name]["function"]["parameters"]["properties"]
        assert "session_id" not in properties
        assert "_session_id" not in properties
    assert "kill_shell" not in schemas
    assert registry.has("kill_shell") is False


def test_builtin_catalog_preserves_default_tool_order() -> None:
    expected = [
        "ask_user_question",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "bash",
            "bash_output",
            "update_plan",
            "skill",
            "skill_create",
        "search_web",
        "fetch_web_page",
    ]

    specs = build_builtin_tool_specs()

    assert tuple(specs) == TOOL_SPECS
    assert [spec.name for spec in specs] == expected
    assert [spec.schema for spec in specs] == [spec.schema for spec in TOOL_SPECS]


def test_builtin_catalog_can_disable_user_questions_and_enable_goal() -> None:
    async def set_goal_status(status: str) -> dict[str, str]:
        return {"status": status}

    specs = build_builtin_tool_specs(
        enable_goal=True,
        enable_user_question=False,
        set_goal_status=set_goal_status,
    )
    registry = DefaultToolRegistry(specs)

    assert registry.has("ask_user_question") is False
    assert registry.has("update_goal") is True
    assert [schema["function"]["name"] for schema in registry.schemas][-1] == "update_goal"
