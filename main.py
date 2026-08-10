import argparse
import sys
from types import SimpleNamespace

from agent.version import __version__


def _validate_agent_assertion(agent_id: str | None) -> None:
    if agent_id is None:
        return
    from agent.infrastructure.team import discover_agent

    resolved = discover_agent()
    if resolved is None:
        raise ValueError("--agent requires the current directory to be a valid Agent workspace.")
    if resolved.agent_id != agent_id:
        raise ValueError(f"--agent {agent_id!r} does not match the current Agent: {resolved.agent_id!r}.")


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["app-server"]:
        from agent.interfaces.runtime_server.app_server import main as app_server_main
        from agent.interfaces.runtime_server.stdio import StdioRuntimeServer

        return app_server_main(arguments[1:], server_class=StdioRuntimeServer)

    parser = argparse.ArgumentParser(description="Rind CLI")
    parser.add_argument("--version", action="version", version=f"rind {__version__}")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode (non-streaming output)")
    parser.add_argument("--session", type=str, default=None, help="Session ID to load")
    parser.add_argument("--agent", type=str, default=None, help="Assert the current Agent Capsule identity")
    parser.add_argument("-c", "--resume-latest", action="store_true", help="Resume the latest session if available")
    parser.add_argument("--session-dir", type=str, default=None, help="Session storage directory")
    parser.add_argument("--doctor", action="store_true", help="Run local setup diagnostics and exit")
    args = parser.parse_args(arguments)

    if args.doctor:
        from agent.interfaces.cli.commands.diagnostics import build_doctor_report

        context = SimpleNamespace(
            runtime=None,
            session=SimpleNamespace(_session_dir=args.session_dir),
            debug=args.debug,
        )
        report = build_doctor_report(context)
        print(report.text)
        return 1 if report.failures else 0

    from agent.infrastructure.paths import validate_session_id

    if args.session is not None:
        try:
            args.session = validate_session_id(args.session)
        except ValueError as exc:
            print(f"Session error: {exc}", file=sys.stderr)
            return 1
    try:
        _validate_agent_assertion(args.agent)
    except ValueError as exc:
        print(f"Startup error: {exc}", file=sys.stderr)
        return 1

    from agent.bootstrap import build_agent_container
    from agent.infrastructure.config import Config, validate_settings
    from agent.interfaces.cli import ChatCLI

    try:
        Config.ensure_user_settings_template()
        settings = Config.reload()
        validate_settings(settings)
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    try:
        container = build_agent_container(
            settings=settings,
            debug=args.debug,
            session_dir=args.session_dir,
            session_id=args.session,
            resume_latest=args.resume_latest,
        )
        ChatCLI(runtime=container.runtime, session=container.session_store, debug=args.debug).start()
    except ValueError as exc:
        print(f"Startup error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
