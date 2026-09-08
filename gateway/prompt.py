"""Terminal prompt utilities for the gateway wizard.

Wrapping ``input`` here gives every prompt uniform EOF behavior: a closed or
Ctrl+Z'd stdin raises :class:`WizardCancelled` instead of a raw traceback.
"""

from __future__ import annotations

import getpass
import sys

from .onboarding import all_guides


class WizardCancelled(Exception):
    """stdin reached EOF (Ctrl+Z / Ctrl+D / closed pipe) — cancel cleanly."""


def input_line(prompt: str = "") -> str:
    try:
        return input(prompt)
    except EOFError:
        raise WizardCancelled() from None


def ask(label: str, default: str = "", secret: bool = False, hint: str = "") -> str:
    """One question; empty input takes the default. ``hint`` replaces the
    ``[default]`` suffix — used to offer a stored secret without printing it.
    """
    suffix = f" [{hint}]" if hint else (f" [{default}]" if default else "")
    # getpass only makes sense on a real terminal: on a piped stdin its Windows
    # fallback reads console keystrokes and hangs forever. Automations pipe the
    # answer in visibly; real terminals keep hidden input.
    if secret and sys.stdin.isatty():
        try:
            value = getpass.getpass(f"{label}{suffix}: ")
        except EOFError:
            raise WizardCancelled() from None
    else:
        value = input_line(f"{label}{suffix}: ")
    return value.strip() or default


def ask_list(label: str, default: list[str] | None = None) -> list[str]:
    shown = "，".join(default) if default else "可留空"
    raw = input_line(f"{label}（逗号分隔，{shown}）: ").strip()
    if not raw:
        return list(default or [])
    return [item for item in raw.replace("，", ",").split(",") if item]


def confirm(label: str, default_yes: bool = True) -> bool:
    hint = "Y/n" if default_yes else "y/N"
    raw = input_line(f"{label} [{hint}]: ").strip().lower()
    if not raw:
        return default_yes
    return raw in ("y", "yes")


def pick_channels() -> list[str]:
    """Channel menu; recommended channels lead. Empty input = Telegram only.

    Unrecognized input never silently falls back to a surprising default —
    the question repeats with the offending tokens called out.
    """
    while True:
        guides = all_guides()
        print("\n可用渠道（回车 = Telegram，零门槛首选）：")
        for index, guide in enumerate(guides, start=1):
            print(f"  {index}. {guide.emoji} {guide.label} — {guide.summary}")
        raw = input_line("选择渠道编号（逗号分隔，如 1,4）: ").strip()
        if not raw:
            return ["telegram"]
        picked: list[str] = []
        unknown: list[str] = []
        for token in raw.replace("，", ",").split(","):
            token = token.strip()
            if token.isdigit() and 1 <= int(token) <= len(guides):
                picked.append(guides[int(token) - 1].id)
            elif token:
                unknown.append(token)
        if unknown:
            print(f"  看不懂这些输入：{'、'.join(unknown)}——请输入菜单里的编号（1-{len(guides)}）。")
            continue
        if picked:
            return picked


__all__ = ["WizardCancelled", "ask", "ask_list", "confirm", "input_line", "pick_channels"]
