from agent.version import __version__
import argparse
import os
import sys
from types import SimpleNamespace


def main() -> int:
    parser = argparse.ArgumentParser(description="Rind CLI")
    parser.add_argument("--version", action="version", version=f"rind {__version__}")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode (non-streaming output)")
    parser.add_argument("--allow-unsafe-bash", action="store_true", help="Allow potentially dangerous shell commands")
    parser.add_argument("--session", type=str, default=None, help="Session ID to load")
    parser.add_argument("-c", "--resume-latest", action="store_true", help="Resume the latest session if available")
    parser.add_argument("--session-dir", type=str, default=None, help="Session storage directory")
    parser.add_argument("--doctor", action="store_true", help="Run local setup diagnostics and exit")
    args = parser.parse_args()

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

    if args.allow_unsafe_bash:
        os.environ["AGENT_ALLOW_UNSAFE_BASH"] = "1"
    try:
        container = build_agent_container(
            settings=settings,
            debug=args.debug,
            session_dir=args.session_dir,
            session_id=args.session,
            resume_latest=args.resume_latest,
        )
        ChatCLI(runtime=container.runtime, session=container.session_store, debug=args.debug).start()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
