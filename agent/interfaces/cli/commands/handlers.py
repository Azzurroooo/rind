"""Handlers for CLI slash commands."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from agent.interfaces.cli.formatting import clip_text, display_value, nonnegative_int, single_line

from .help_view import render_command_help, render_help
from .model_control import normalize_model_name, set_active_model
from .router import SlashCommandContext, SlashCommandInfo, SlashCommandResult
from .status_view import build_status_display, render_status_display


COMMAND_INFOS = (
    SlashCommandInfo("help", "Show commands", "/help [command]"),
    SlashCommandInfo("status", "Show session status", "/status"),
    SlashCommandInfo("doctor", "Run local setup diagnostics", "/doctor"),
    SlashCommandInfo("sessions", "List recent sessions", "/sessions [limit]"),
    SlashCommandInfo("skill", "List skills", "/skill [list]"),
    SlashCommandInfo("init", "Draft RIND.md", "/init [project|user]"),
    SlashCommandInfo("plan", "Show active plan summary", "/plan"),
    SlashCommandInfo("compact", "Compact current session context", "/compact"),
    SlashCommandInfo("model", "Show or change the active model", "/model | /model set <model>"),
    SlashCommandInfo("clear", "Clear terminal output", "/clear"),
    SlashCommandInfo("draft", "Show, reuse, or clear saved input draft", "/draft | /draft use | /draft clear"),
    SlashCommandInfo("login", "Show login setup guidance", "/login"),
    SlashCommandInfo("config", "Show config guidance", "/config"),
    SlashCommandInfo("exit", "Exit CLI", "/exit", aliases=("quit",)),
)

def default_command_infos() -> list[SlashCommandInfo]:
    return list(COMMAND_INFOS)


def default_handlers() -> dict[str, Callable]:
    return {
        "help": handle_help,
        "status": handle_status,
        "doctor": handle_doctor,
        "sessions": handle_sessions,
        "skill": handle_skill,
        "init": handle_init,
        "plan": handle_plan,
        "compact": handle_compact,
        "model": handle_model,
        "clear": handle_clear,
        "draft": handle_draft,
        "login": handle_login,
        "config": handle_config,
        "exit": handle_exit,
        "quit": handle_exit,
    }


async def handle_help(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if len(args) > 1:
        return "Usage: /help [command]"
    if args:
        name = args[0].strip().lstrip("/").lower()
        info = _find_command_info(name)
        text = render_command_help(COMMAND_INFOS, args[0])
        if info is None:
            return text
        return SlashCommandResult(text, display={"type": "help", "commands": _command_display_list(), "command": _command_display(info)})
    return SlashCommandResult(render_help(COMMAND_INFOS), display={"type": "help", "commands": _command_display_list()})


async def handle_status(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /status"
    display = await build_status_display(context)
    return SlashCommandResult(render_status_display(display), display=display)


async def handle_doctor(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args:
        return "Usage: /doctor"
    from .diagnostics import build_doctor_report

    report = build_doctor_report(context)
    return SlashCommandResult(report.text, display=report.display)


async def handle_sessions(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    limit = _parse_limit(args, default=8, maximum=20)
    if limit is None:
        return "Usage: /sessions [limit]"
    list_sessions = getattr(context.session, "list_recent_sessions", None)
    if not callable(list_sessions):
        return "Sessions are not supported by this session store."
    try:
        sessions = await list_sessions(limit=limit)
    except Exception as exc:
        return f"Command failed: {exc}"
    current_id = str(getattr(context.session, "session_id", "") or "")
    if not sessions:
        return SlashCommandResult(
            "No recent sessions.",
            display={
                "type": "sessions",
                "sessions": [],
                "current_session_id": current_id,
                "limit": limit,
                "resume_command": "python main.py --session <id>",
            },
        )

    lines = ["Recent sessions:"]
    display_sessions = []
    for item in sessions[:limit]:
        if not isinstance(item, dict):
            continue
        session_id = display_value(item.get("id"))
        marker = " (current)" if current_id and session_id == current_id else ""
        updated = display_value(item.get("updated_at"))
        title = clip_text(display_value(item.get("title")), 40)
        size_data = item.get("size")
        size = _format_session_size(size_data)
        preview = clip_text(single_line(item.get("preview")), 56)
        suffix = f" | {preview}" if preview else ""
        lines.append(f"- {session_id}{marker} | {updated} | {title} | {size}{suffix}")
        display_sessions.append(
            {
                "id": session_id,
                "current": bool(current_id and session_id == current_id),
                "updated_at": updated,
                "title": display_value(item.get("title")),
                "messages": nonnegative_int(size_data.get("messages")) if isinstance(size_data, dict) else None,
                "tool_calls": nonnegative_int(size_data.get("tool_calls")) if isinstance(size_data, dict) else None,
                "preview": single_line(item.get("preview")),
            }
        )
    lines.append("Resume with: python main.py --session <id>")
    return SlashCommandResult(
        "\n".join(lines),
        display={
            "type": "sessions",
            "sessions": display_sessions,
            "current_session_id": current_id,
            "limit": limit,
            "resume_command": "python main.py --session <id>",
        },
    )


async def handle_skill(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if args and args[0].lower() != "list":
        return "Usage: /skill or /skill list"
    try:
        from agent.infrastructure.skills.skill_repository import SkillRepository

        skills = SkillRepository(project_root=str(Path.cwd())).list_skills()
    except Exception as exc:
        return f"Command failed: {exc}"
    if not skills:
        return SlashCommandResult("No skills found.", display={"type": "skills", "skills": []})
    lines = ["Skills:"]
    display_skills = []
    for skill in skills:
        description = str(getattr(skill, "description", "") or "").strip()
        path = str(getattr(skill, "path", "") or "")
        lines.append(f"- {skill.name} [{skill.source}] {description} ({path})")
        display_skills.append(
            {
                "name": str(getattr(skill, "name", "") or ""),
                "source": str(getattr(skill, "source", "") or ""),
                "description": description,
                "path": path,
            }
        )
    return SlashCommandResult("\n".join(lines), display={"type": "skills", "skills": display_skills})


async def handle_init(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if len(args) > 1:
        return SlashCommandResult("Usage: /init [project|user]")
    scope = args[0].lower() if args else "project"
    if scope not in {"project", "user"}:
        return SlashCommandResult("Usage: /init [project|user]")

    from agent.infrastructure.rind_docs import resolve_project_doc_path, resolve_user_doc_path
    from agent.prompts import build_rind_init_prompt

    target = resolve_project_doc_path() if scope == "project" else resolve_user_doc_path()
    prompt = build_rind_init_prompt(scope, str(target))
    return SlashCommandResult(
        text=f"Initializing {scope} RIND.md: {target}",
        run_turn_input=f"Initialize {scope} RIND.md at {target}",
        transient_system_messages=[
            {
                "role": "system",
                "content": prompt,
                "_context_kind": "rind_init",
            }
        ],
    )


async def handle_plan(context: SlashCommandContext, args: list[str]) -> str:
    try:
        from agent.infrastructure.plans.store import load_plan_if_exists
        from agent.infrastructure.plans.state_summary import render_compact_plan_summary

        plan = load_plan_if_exists()
        summary = render_compact_plan_summary(plan) if plan else ""
    except FileNotFoundError:
        summary = ""
    except Exception as exc:
        return f"Command failed: {exc}"
    return summary or "No active plan."


async def handle_compact(context: SlashCommandContext, args: list[str]) -> SlashCommandResult | str:
    compact_context = getattr(context.runtime, "compact_context", None)
    if not callable(compact_context):
        return "Compact is not supported by this runtime."
    record = await compact_context(reason="manual", cancellation_token=context.cancellation_token)
    source = record.get("source") if isinstance(record, dict) else {}
    if not isinstance(source, dict):
        source = {}
    start = source.get("message_start_index", "?")
    end = source.get("message_end_index_exclusive", "?")
    tool_count = len(source.get("tool_call_ids") or [])
    return SlashCommandResult(
        "\n".join(
            [
                "Compact complete.",
                f"- id: {display_value(record.get('id') if isinstance(record, dict) else None)}",
                f"- source: messages[{start}:{end}]",
                f"- tool calls: {tool_count}",
            ]
        ),
        context_usage_reset=True,
    )


async def handle_model(context: SlashCommandContext, args: list[str]) -> str:
    from agent.infrastructure.config import Config

    if not args:
        active = display_value(getattr(context.session, "model", None))
        configured = display_value(Config.DEFAULT_MODEL)
        if active == configured:
            return f"Model: {active}"
        return f"Model:\n- active: {active}\n- default: {configured}"

    if len(args) != 2 or args[0].lower() != "set":
        return "Usage: /model or /model set <model>"

    model = normalize_model_name(args[1])
    if model is None:
        return "Usage: /model set <model>"

    previous = display_value(Config.DEFAULT_MODEL)
    try:
        result = await set_active_model(context.runtime, context.session, model)
        active_updated = bool(result.get("active_updated"))
    except Exception as exc:
        return f"Command failed: {exc}"

    lines = [
        "Model updated.",
        f"- previous default: {previous}",
        f"- new default: {Config.DEFAULT_MODEL}",
    ]
    if active_updated:
        lines.append("- active session: updated")
    else:
        lines.append("- active session: unchanged; start a new session to use this model")
    return "\n".join(lines)


async def handle_clear(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    if args:
        return SlashCommandResult("Usage: /clear")
    return SlashCommandResult(clear_screen=True)


async def handle_draft(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if len(args) > 1 or (args and args[0].lower() not in {"use", "clear"}):
        return "Usage: /draft, /draft use, or /draft clear"
    path = _draft_path(context.session)
    if args and args[0].lower() == "clear":
        return _clear_draft(path)
    if args and args[0].lower() == "use":
        draft = _read_draft(path)
        if draft is None:
            return "No saved input draft."
        return SlashCommandResult("Draft loaded into the next prompt.", input_prefill=draft)
    if path is None or not path.exists():
        return "No saved input draft."
    draft = _read_draft(path)
    if draft is None:
        return "No saved input draft."
    return f"Saved input draft: {path}\n\n{draft}"


async def handle_login(context: SlashCommandContext, args: list[str]) -> str:
    return "Login/config setup is not implemented yet.\nCreate settings.json under RIND_HOME, or ~/.rind when RIND_HOME is unset."


async def handle_config(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    from agent.infrastructure.config import Config

    api_key_state = "set" if Config.OPENAI_API_KEY else "unset"
    reasoning = Config.MODEL_REASONING_EFFORT or "unset"
    settings_state = "found" if Config.SETTINGS_EXISTS else "missing"
    entries = [
        {"label": "settings", "value": str(Config.SETTINGS_PATH), "state": settings_state},
        {"label": "apiKey", "value": api_key_state},
        {"label": "baseUrl", "value": str(Config.OPENAI_API_BASE)},
        {"label": "model", "value": str(Config.DEFAULT_MODEL)},
        {"label": "reasoningEffort", "value": str(reasoning)},
    ]
    return SlashCommandResult(
        "\n".join(
            [
                "Config:",
                f"- settings: {Config.SETTINGS_PATH} ({settings_state})",
                f"- apiKey: {api_key_state}",
                f"- baseUrl: {Config.OPENAI_API_BASE}",
                f"- model: {Config.DEFAULT_MODEL}",
                f"- reasoningEffort: {reasoning}",
            ]
        ),
        display={"type": "config", "entries": entries},
    )


async def handle_exit(context: SlashCommandContext, args: list[str]) -> SlashCommandResult:
    return SlashCommandResult("再见！", should_exit=True)


def _draft_path(session) -> Path | None:
    base = _session_base_path(session)
    return base / "input_draft.txt" if base else None


def _clear_draft(path: Path | None) -> str:
    if path is None or not path.exists():
        return "No saved input draft."
    try:
        path.unlink()
    except Exception as exc:
        return f"Command failed: {exc}"
    return "Saved input draft cleared."


def _read_draft(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    try:
        draft = path.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    return draft or None


def _session_base_path(session) -> Path | None:
    paths = getattr(session, "_session_paths", None)
    if isinstance(paths, dict) and paths.get("base"):
        return Path(str(paths["base"]))
    root = getattr(session, "_session_root", None)
    session_id = getattr(session, "session_id", None)
    if root and session_id:
        return Path(str(root)) / str(session_id)
    return None


def _parse_limit(args: list[str], *, default: int, maximum: int) -> int | None:
    if not args:
        return default
    if len(args) != 1:
        return None
    try:
        limit = int(args[0])
    except ValueError:
        return None
    if limit <= 0:
        return None
    return min(limit, maximum)


def _format_session_size(value: object) -> str:
    if not isinstance(value, dict):
        return "unknown"
    messages = nonnegative_int(value.get("messages"))
    tools = nonnegative_int(value.get("tool_calls"))
    return f"{messages} msg, {tools} tool"


def _command_display_list() -> list[dict]:
    return [_command_display(info) for info in COMMAND_INFOS]


def _command_display(info: SlashCommandInfo) -> dict:
    return {
        "name": info.name,
        "description": info.description,
        "usage": info.usage,
        "aliases": list(info.aliases),
    }


def _find_command_info(name: str) -> SlashCommandInfo | None:
    for info in COMMAND_INFOS:
        if info.name == name or name in info.aliases:
            return info
    return None
