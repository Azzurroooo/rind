import pytest


@pytest.fixture
def shell_tools(tmp_path):
    from agent.infrastructure.persistence import ToolOutputStore
    from agent.infrastructure.tools.builtin.shell import ShellTools

    tools = ShellTools(ToolOutputStore(str(tmp_path)))
    yield tools
    tools.close_now()
