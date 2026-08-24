"""Application entrypoint for the headless Rind runtime server."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from agent.bootstrap import build_agent_container
from agent.infrastructure.config import Config, validate_settings
from agent.infrastructure.paths import validate_session_id
from agent.infrastructure.tools.builtin.shell.tool import (
    list_backgrounds as background_list,
    snapshot_background as background_output,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Rind headless runtime server")
    parser.add_argument("--stdio", action="store_true", help="Use the JSONL standard-stream transport")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--cwd", type=str, default=None, help="Workspace directory for this runtime")
    parser.add_argument("--session", type=str, default=None)
    parser.add_argument("-c", "--resume-latest", action="store_true")
    parser.add_argument("--session-dir", type=str, default=None)
    parser.add_argument(
        "--trace-llm",
        action="store_true",
        help="Record every LLM request/response under <session>/_llm_trace/ (debug).",
    )
    return parser


def _resolve_workspace_root(cwd: str | None) -> str:
    workspace_root = Path(cwd or Path.cwd()).expanduser().resolve()
    if not workspace_root.is_dir():
        raise ValueError(f"Workspace directory does not exist: {workspace_root}")
    return str(workspace_root)


def _write_startup_error(label: str, exc: Exception, debug: bool) -> None:
    print(f"{label}: {exc}", file=sys.stderr)
    if debug:
        traceback.print_exception(exc, file=sys.stderr)


async def async_main(argv: list[str] | None = None, *, server_class: type[Any]) -> int:
    args = build_parser().parse_args(argv)
    if args.trace_llm:
        os.environ["RIND_TRACE_LLM"] = "1"
    try:
        workspace_root = _resolve_workspace_root(args.cwd)
    except ValueError as exc:
        _write_startup_error("Startup error", exc, args.debug)
        return 1
    if args.session is not None:
        try:
            args.session = validate_session_id(args.session)
        except ValueError as exc:
            _write_startup_error("Session error", exc, args.debug)
            return 1

    try:
        Config.ensure_user_settings_template()
        settings = Config.reload(workspace_root)
        validate_settings(settings)
    except Exception as exc:
        _write_startup_error("Configuration error", exc, args.debug)
        return 1

    if getattr(server_class, "worker_mode", False):
        from agent.runtime.server.worker import RuntimeWorker

        worker = None
        server_started = False
        try:
            worker = RuntimeWorker(
                settings=settings,
                workspace_root=workspace_root,
                session_id=args.session,
                resume_latest=args.resume_latest,
                session_dir=args.session_dir,
                debug=args.debug,
                enable_goal=True,
            )
            server = server_class(
                worker,
                debug=args.debug,
                background_list=background_list,
                background_output=background_output,
                goal_enabled=True,
            )
            server_started = True
            try:
                return await server.run()
            except Exception:
                server_started = False
                raise
        except Exception as exc:
            _write_startup_error("Runtime error", exc, args.debug)
            return 1
        finally:
            if worker is not None and not server_started:
                await worker.close()

    previous_cwd = Path.cwd()
    container = None
    try:
        os.chdir(workspace_root)
        container = build_agent_container(
            settings=settings,
            debug=args.debug,
            session_dir=args.session_dir,
            session_id=args.session,
            resume_latest=args.resume_latest,
            enable_goal=True,
            workspace_root=workspace_root,
        )
        server = server_class(
            container.runtime,
            container.session_store,
            debug=args.debug,
            model_client_factory=container.provider_client_factory.create_async_client,
            default_model=container.settings.model,
            background_list=background_list,
            background_output=background_output,
            goal_enabled=True,
        )
        return await server.run()
    except Exception as exc:
        _write_startup_error("Runtime error", exc, args.debug)
        return 1
    finally:
        if container is not None:
            try:
                await container.session_store.discard_if_empty()
            except Exception as exc:
                _write_startup_error("Shutdown error", exc, args.debug)
        os.chdir(previous_cwd)


def main(argv: list[str] | None = None, *, server_class: type[Any]) -> int:
    from agent.runtime.server.stdio import (
        configure_stdio_server_signals,
        configure_utf8_stdio,
    )

    configure_stdio_server_signals()
    configure_utf8_stdio()
    return asyncio.run(async_main(argv, server_class=server_class))
