import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.bootstrap import container


@pytest.mark.asyncio
async def test_build_dependencies_does_not_create_project_sessions(monkeypatch, tmp_path) -> None:
    workspace = tmp_path / "workspace"
    rind_home = tmp_path / "home" / ".rind"
    workspace.mkdir()

    monkeypatch.chdir(workspace)
    monkeypatch.setenv("RIND_HOME", str(rind_home))
    monkeypatch.setattr(container.Config, "get_async_client", classmethod(lambda cls: object()))

    deps = container.build_basic_agent_dependencies()
    await deps["session"].initialize()

    if (workspace / "sessions").exists():
        raise AssertionError("Did not expect project-local sessions directory")
    if not (rind_home / "sessions").exists():
        raise AssertionError("Expected user-level Rind sessions directory")


def main() -> int:
    import asyncio

    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch = pytest.MonkeyPatch()
        try:
            asyncio.run(
                test_build_dependencies_does_not_create_project_sessions(
                    monkeypatch,
                    Path(temp_dir),
                )
            )
        finally:
            monkeypatch.undo()
    print("No project sessions tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
