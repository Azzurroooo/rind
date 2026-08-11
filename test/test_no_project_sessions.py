import sys
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.bootstrap import container
from agent.infrastructure.config import AppSettings


class FakeProviderClientFactory:
    def create_async_client(self):
        return object()


@pytest.mark.asyncio
async def test_build_dependencies_does_not_create_project_sessions(monkeypatch, tmp_path) -> None:
    workspace = tmp_path / "workspace"
    rind_home = tmp_path / "home" / ".rind"
    workspace.mkdir()

    monkeypatch.chdir(workspace)
    monkeypatch.setenv("RIND_HOME", str(rind_home))
    settings = AppSettings(
        settings_path=rind_home / "settings.json",
        settings_exists=True,
        model="test-model",
        api_key="test-key",
        base_url="https://example.com/v1",
        reasoning_effort="",
        user_agent="test-agent",
    )

    deps = container.build_agent_container(
        settings=settings,
        provider_client_factory=FakeProviderClientFactory(),
    )
    await deps.session_store.initialize()

    if (workspace / "sessions").exists():
        raise AssertionError("Did not expect project-local sessions directory")
    if rind_home.exists():
        raise AssertionError("Draft initialization must not create the user-level Rind directory")


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
