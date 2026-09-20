"""Recognize forbidden command invocations, not words inside command data."""

from __future__ import annotations

import re
from typing import Literal

BashPolicyStatus = Literal["allow", "deny"]

_TOKEN = re.compile(r"\"(?:`.|\\.|[^\"])*\"|'(?:''|[^'])*'|`[^`]*`|\$\([^()]*\)|#[^\n]*|<<-?|[;&|(){}<>\n]+|[^\s;&|(){}<>\"']+")
_FORBIDDEN = re.compile(r"(?:format(?:\.exe|\.com)?|mkfs(?:\.[a-z0-9]+)?|shutdown(?:\.exe)?|reboot(?:\.exe)?|format-volume)", re.I)
_SHELLS = {"bash", "sh", "cmd", "powershell", "pwsh"}


def _tokens(command: str):
    pending = []
    delimiter_next = False
    skip_until = 0
    for match in _TOKEN.finditer(command):
        if match.start() < skip_until:
            continue
        token = match.group()
        if token.startswith("#"):
            continue
        if delimiter_next:
            pending.append(token.strip("\"'"))
            delimiter_next = False
        if token in {"<<", "<<-"}:
            delimiter_next = True
        if "\n" in token and pending:
            start = match.end()
            for delimiter in pending:
                end = re.search(r"(?m)^\t*" + re.escape(delimiter) + r"\r?$", command[start:])
                if end is None:
                    skip_until = len(command)
                    break
                skip_until = start + end.end()
                start = skip_until
            pending.clear()
        yield token


class BashPolicy:
    """A small invocation filter for Bash/sh and PowerShell, not a script sandbox."""

    @classmethod
    def classify(cls, command: str, backend: str = "bash") -> tuple[BashPolicyStatus, str | None]:
        position = True
        executable = ""
        script_next = False
        redirect_next = False
        invocation = False
        tokens = list(_tokens(command))
        for token in tokens:
            if not token.startswith("'"):
                substitutions = re.findall(r"\$\(([^()]*)\)", token)
                if backend != "powershell":
                    substitutions += re.findall(r"`([^`]*)`", token)
                for script in substitutions:
                    result = cls.classify(script, backend)
                    if result[0] == "deny":
                        return result
            if script_next:
                result = cls.classify(token.strip("\"'"), "powershell" if executable in {"powershell", "pwsh"} else "bash")
                if result[0] == "deny":
                    return result
                script_next = False
            if re.fullmatch(r"[;&|(){}\n]+", token):
                position = True
                invocation = token == "&"
                executable = ""
                continue
            if token in {">", ">>", "<", "<<", "<<-"}:
                redirect_next = True
                continue
            if redirect_next:
                redirect_next = False
                continue
            if position:
                if token in {"if", "then", "elif", "else", "do", "!", "sudo", "env", "command", "exec", "builtin", "call"} or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token):
                    continue
                if backend == "powershell" and token == ".":
                    invocation = True
                    continue
                if backend == "powershell" and token[0] in "\"'" and not invocation:
                    position = False
                    continue
                name = re.split(r"[/\\]", token.strip("\"'"))[-1].lower()
                if _FORBIDDEN.fullmatch(name):
                    return "deny", f"Detected {name} command."
                executable = name.removesuffix(".exe")
                position = False
            elif executable in _SHELLS and token.lower() in {"-c", "-lc", "/c", "/k", "-command"}:
                script_next = True
        syntax = " ".join(token for token in tokens if token[0] not in "\"'")
        if re.search(r":\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", syntax):
            return "deny", "Detected fork bomb pattern."
        return "allow", None
