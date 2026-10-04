import asyncio
import json
import sys
import textwrap

import pytest

from gateway import transports
from gateway.transports import _StdioTransport


@pytest.mark.asyncio
async def test_stdio_close_drains_output_and_waits_for_eof_cleanup(tmp_path):
    marker = tmp_path / "cleaned"
    transport = _StdioTransport([sys.executable, "-c", textwrap.dedent("""
        import pathlib, sys
        print('{"ready": true}', flush=True)
        sys.stdin.read()
        sys.stdout.write('x' * 1048576)
        sys.stdout.flush()
        pathlib.Path(sys.argv[1]).write_text('cleaned')
    """), str(marker)])
    await transport.open()
    process = transport._process
    try:
        assert await transport.read() == {"ready": True}
        await asyncio.wait_for(transport.close(), 5)
        assert process.returncode == 0
        assert marker.read_text() == "cleaned"
        assert transport._process is None
        await transport.close()
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["timeout", "failure"])
async def test_stdio_close_surfaces_failure_and_reaps_worker(monkeypatch, mode):
    code = "import sys,time; print('{\"ready\":true}',flush=True); sys.stdin.read(); "
    code += "time.sleep(60)" if mode == "timeout" else "sys.exit(7)"
    transport = _StdioTransport([sys.executable, "-c", code])
    await transport.open()
    process = transport._process
    try:
        assert await transport.read() == {"ready": True}
        monkeypatch.setattr(transports, "SHUTDOWN_TIMEOUT_SECONDS", 0.1)
        expected = "forced termination" if mode == "timeout" else "code 7"
        with pytest.raises((TimeoutError, RuntimeError), match=expected):
            await transport.close()
        assert process.returncode is not None
        assert transport._process is None
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


@pytest.mark.asyncio
@pytest.mark.parametrize("notify", ["manual", "on_exit"])
async def test_stdio_eof_stops_real_worker_and_background_descendant(tmp_path, notify):
    connected, disconnected = asyncio.Event(), asyncio.Event()

    async def connection(reader, writer):
        connected.set()
        try:
            await reader.read()
        except ConnectionResetError:
            pass
        finally:
            writer.close()
            disconnected.set()

    server = await asyncio.start_server(connection, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    code = textwrap.dedent("""
        import asyncio, os, pathlib, sys
        root = pathlib.Path(sys.argv[1])
        os.environ['RIND_HOME'] = str(root / 'home')
        from agent.runtime.server.worker import RuntimeWorker
        from agent.runtime.server.stdio import StdioRuntimeServer
        from agent.infrastructure.tools.shell.session_pool import ShellState

        async def main():
            worker = RuntimeWorker(workspace_root=str(root), session_dir=str(root / 'sessions'))
            state = ShellState(cwd=str(root), env=dict(os.environ), shell_executable=sys.executable)
            child = "import socket; s=socket.create_connection(('127.0.0.1', %s)); print('ready',flush=True); s.recv(1)" % sys.argv[2]
            parent = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',%r],stdout=subprocess.PIPE); p.stdout.readline(); time.sleep(60)" % child
            try:
                result = await worker.shell_tools.supervisor.run(parent, state, 'owned', yield_time_ms=0, notify=sys.argv[3])
                print(result.result_str, flush=True)
                return await StdioRuntimeServer(worker).run()
            finally:
                await worker.close()
        sys.exit(asyncio.run(main()))
    """)
    transport = _StdioTransport([sys.executable, "-c", code, str(tmp_path), str(port), notify])
    await transport.open()
    process = transport._process
    try:
        result = await asyncio.wait_for(transport.read(), 10)
        assert result["data"]["handoff"]
        await asyncio.wait_for(connected.wait(), 5)
        await asyncio.wait_for(transport.close(), 10)
        await asyncio.wait_for(disconnected.wait(), 5)
        assert process.returncode == 0
        records = [json.loads(line) for line in (tmp_path / "sessions" / "owned" / "tasks.jsonl").read_text(encoding="utf-8").splitlines()]
        assert records[-1]["status"] == "cancelled"
    finally:
        try:
            if process.returncode is None:
                await transport.close()
            await process.wait()
        finally:
            server.close()
            await server.wait_closed()
