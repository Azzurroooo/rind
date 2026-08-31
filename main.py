"""Rind Runtime Package entrypoint."""

from __future__ import annotations

import argparse
import sys

from agent.version import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Rind Runtime Package")
    parser.add_argument("--version", action="version", version=f"rind {__version__}")
    parser.add_argument("command", nargs="?", choices=("app-server",), help="Runtime command")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["app-server"]:
        from agent.runtime.server.app_server import main as app_server_main
        if "--web" in arguments[1:]:
            from agent.runtime.server.web import WebRuntimeServer as server_class
        else:
            from agent.runtime.server.stdio import WorkerStdioRuntimeServer as server_class

        return app_server_main(arguments[1:], server_class=server_class)

    parsed = build_parser().parse_args(arguments)
    if parsed.command is None:
        build_parser().error("the following argument is required: command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
