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


def ask(label: str, default: str = "", secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
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


def ask_list(label: str) -> list[str]:
    raw = input_line(f"{label}（逗号分隔，可留空）: ").strip()
    return [item for item in raw.replace("，", ",").split(",") if item]


def confirm(label: str, default_yes: bool = True) -> bool:
    hint = "Y/n" if default_yes else "y/N"
    raw = input_line(f"{label} [{hint}]: ").strip().lower()
    if not raw:
        return default_yes
    return raw in ("y", "yes")


def pick_channels() -> list[str]:
    guides = all_guides()
    print("\n可用渠道（回车 = Telegram + Email 两个零门槛渠道）：")
    for index, guide in enumerate(guides, start=1):
        print(f"  {index}. {guide.emoji} {guide.label} — {guide.summary}")
    raw = input_line("选择渠道编号（逗号分隔，如 1,4）: ").strip()
    if not raw:
        return ["telegram", "email"]
    picked: list[str] = []
    for token in raw.replace("，", ",").split(","):
        token = token.strip()
        if token.isdigit() and 1 <= int(token) <= len(guides):
            picked.append(guides[int(token) - 1].id)
    return picked or ["telegram", "email"]


__all__ = ["WizardCancelled", "ask", "ask_list", "confirm", "input_line", "pick_channels"]
