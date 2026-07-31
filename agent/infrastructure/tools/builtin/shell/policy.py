"""Bash policy for evaluating command safety."""

from __future__ import annotations

import re
from typing import Literal

BashPolicyStatus = Literal["allow", "deny"]


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
    def classify(cls, command: str) -> tuple[BashPolicyStatus, str | None]:
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

        return "allow", None
