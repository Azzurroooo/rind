"""Launcher lifecycle tests use fake processes, not manual UI acceptance."""

from pathlib import Path
from types import SimpleNamespace

import pytest

import bench_interactive as bench


@pytest.mark.parametrize("outcome", ["normal", "interrupted", "manifest_exists"])
def test_launcher_cleans_owned_processes_and_temporary_home(monkeypatch, tmp_path, outcome):
    manifest = tmp_path / "launch.json"
    if outcome == "manifest_exists":
        manifest.write_text("existing trial", encoding="utf-8")
    monkeypatch.setattr(bench.sys, "argv", ["bench_interactive.py", "--manifest", str(manifest)])
    monkeypatch.setattr(bench.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(bench.sys.stdout, "isatty", lambda: True)
    monkeypatch.setattr(bench.subprocess, "check_output", lambda *args, **kwargs: "test-sha")
    observed = {}
    stopped = []
    server = SimpleNamespace(base_url="http://127.0.0.1:1/v1", script_text=lambda **kwargs: None,
                             start=lambda: None, stop=lambda: stopped.append(True))
    monkeypatch.setattr(bench, "FakeOpenAIServer", lambda: server)

    class Child:
        def __init__(self, pid):
            self.pid = pid
            self.alive = True

        def children(self, recursive):
            return [worker] if self.pid == 10 else []

        def is_running(self):
            return self.alive

        def terminate(self):
            self.alive = False

    root, worker = Child(10), Child(11)
    monkeypatch.setattr(bench.psutil, "Process", lambda pid: root)
    monkeypatch.setattr(bench.psutil, "wait_procs", lambda children, timeout: (
        [p for p in children if not p.alive], [p for p in children if p.alive]))

    class Popen:
        pid = 10
        returncode = None

        def __init__(self, command, cwd, env):
            observed["workspace"] = Path(command[-1])
            observed["home"] = Path(env["RIND_HOME"])
            assert "local-fixture-only" in (observed["home"] / "settings.json").read_text()

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            if outcome == "interrupted" and timeout:
                raise KeyboardInterrupt
            self.returncode = 0
            return 0

    monkeypatch.setattr(bench.subprocess, "Popen", Popen)
    if outcome == "normal":
        bench.main()
    else:
        with pytest.raises(KeyboardInterrupt if outcome == "interrupted" else FileExistsError):
            bench.main()
    assert not root.alive and not worker.alive
    assert stopped == [True]
    assert not observed["workspace"].exists()
    assert not observed["home"].parent.exists()
    if outcome == "manifest_exists":
        assert manifest.read_text() == "existing trial"
