import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.tool_executor import ToolExecutor
from agent.infrastructure.tools.registry import DefaultToolRegistry


class FakeRegistry:
    @property
    def schemas(self):
        return []

    def has(self, name: str) -> bool:
        return name in {"sync_tool", "async_tool"}

    def is_async(self, name: str) -> bool:
        return name == "async_tool"

    def call(self, name: str, args: dict):
        return f"sync:{args.get('value')}"

    async def call_async(self, name: str, args: dict):
        return f"async:{args.get('value')}"


def test_tool_executor_exposes_async_tool_check() -> None:
    executor = ToolExecutor(registry=FakeRegistry())

    if executor.is_async_tool("async_tool") is not True:
        raise AssertionError("Expected async_tool to be async")
    if executor.is_async_tool("sync_tool") is not False:
        raise AssertionError("Expected sync_tool to be sync")


def test_default_registry_filters_private_args_unless_declared() -> None:
    def public_tool(value: str):
        return value

    def token_tool(value: str, _cancellation_token=None):
        return _cancellation_token

    marker = object()
    registry = DefaultToolRegistry(
        tool_map={"public_tool": public_tool, "token_tool": token_tool},
        schemas=[],
    )

    if registry.call("public_tool", {"value": "ok", "_cancellation_token": marker}) != "ok":
        raise AssertionError("Expected private args to be filtered from tools that do not declare them.")
    if registry.call("token_tool", {"value": "ok", "_cancellation_token": marker}) is not marker:
        raise AssertionError("Expected declared private arg to be passed through.")


def main() -> int:
    test_tool_executor_exposes_async_tool_check()
    test_default_registry_filters_private_args_unless_declared()
    print("ToolExecutor tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
