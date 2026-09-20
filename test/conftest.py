import pytest


@pytest.fixture
def shell_tools(tmp_path):
    from agent.infrastructure.persistence import ToolOutputStore
    from agent.infrastructure.tools.shell.specs import ShellTools

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
