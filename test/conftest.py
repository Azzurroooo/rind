import pytest


@pytest.fixture(autouse=True)
def isolated_rind_home(monkeypatch, tmp_path_factory):
    """No test, nor a worker process it starts, writes into the developer's own RIND_HOME."""
    monkeypatch.setenv("RIND_HOME", str(tmp_path_factory.mktemp("rind-home")))


@pytest.fixture
def shell_tools(tmp_path):
    from agent.infrastructure.persistence import ToolOutputStore
    from agent.infrastructure.tools.shell.tool import ShellTools

    tools = ShellTools(ToolOutputStore(str(tmp_path)))
    yield tools
    tools.close_now()


@pytest.fixture
def build_builtin_tool_specs(shell_tools):
    from functools import partial
    from agent.infrastructure.tools.catalog import build_builtin_tool_specs
    from agent.infrastructure.tools.web.session_pool import WebSessions

    sessions = WebSessions()
    yield partial(build_builtin_tool_specs, shell_tools=shell_tools, web_sessions=sessions)
    sessions.close()
