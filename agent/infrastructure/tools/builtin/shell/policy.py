"""Bash policy for evaluating command safety."""

from __future__ import annotations

import os
import re
from typing import Literal

ApprovalStatus = Literal["allow", "deny", "needs_approval"]


class BashPolicy:
    """Evaluates whether a command is safe to execute."""

    @staticmethod
    def _match_patterns(command: str, patterns: list[tuple[str, str]]) -> str | None:
        s = command.strip()
        if not s:
            return None
        for pat, reason in patterns:
            if re.search(pat, s, flags=re.IGNORECASE):
                return reason
        return None

    @classmethod
    def classify(cls, command: str) -> tuple[ApprovalStatus, str | None]:
        """Classify a command's safety level."""

        # 1. Check absolutely forbidden commands
        forbidden_patterns = [
            (r"\bformat\b", "Detected format command."),
            (r"\bmkfs\b", "Detected mkfs command."),
            (r"\bshutdown\b", "Detected shutdown command."),
            (r"\breboot\b", "Detected reboot command."),
            (r":\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "Detected fork bomb pattern."),
        ]

        forbidden_reason = BashPolicy._match_patterns(command, forbidden_patterns)
        if forbidden_reason:
            return "deny", forbidden_reason

        # 2. Check confirmable commands
        confirmable_patterns = [
            (r"\brm\b", "Detected rm command."),
            (r"\bdel\b.*\s/([qs]|s)\b", "Detected Windows del with recursive/silent flags."),
            (r"\brmdir\b.*\s/([qs]|s)\b", "Detected Windows rmdir with recursive/silent flags."),
            (r"\bRemove-Item\b.*-Recurse\b", "Detected PowerShell recursive removal."),
        ]

        confirm_reason = BashPolicy._match_patterns(command, confirmable_patterns)
        if confirm_reason:
            if BashPolicy._unsafe_mode_enabled():
                return "allow", "Unsafe mode enabled."
            return "needs_approval", confirm_reason

        return "allow", None

    @staticmethod
    def _unsafe_mode_enabled() -> bool:
        value = os.getenv("AGENT_ALLOW_UNSAFE_BASH", "")
        return value.strip().lower() in {"1", "true", "yes", "on"}
