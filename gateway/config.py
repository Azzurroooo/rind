"""Parsing and validation for ``gateway.yaml`` (hand-rolled YAML subset).

Supported subset: indentation mappings, scalars (``true``/``false``, integers,
plain / single-quoted / double-quoted strings), inline string lists
``["a", "b"]``, ``#`` comments and ``${VAR}`` environment interpolation.
Unknown keys anywhere are a startup error and required keys never fall back to
defaults; validation failures surface as a single-line :class:`ConfigError`
that ``gateway.main`` prints to stderr before exiting 2.  This module is pure
(stdlib only) so it stays importable without the ``agent`` package.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

_VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_INT_PATTERN = re.compile(r"^-?\d+$")

_KNOWN_TOP_LEVEL = frozenset(
    {"worker", "workspace", "worker_token", "channels", "pairing", "cooldown_per_minute", "uploads_dir"}
)
_KNOWN_PAIRING = frozenset({"enabled", "ttl_minutes"})
_KNOWN_CHANNEL = frozenset({"token", "allow_from", "group_allow"})
# Per-channel extensions beyond the common keys (WP11: wecom / whatsapp / email).
# Every channel also accepts _KNOWN_CHANNEL; unknown keys still error (§2).
_CHANNEL_KEYS: dict[str, frozenset[str]] = {
    "wecom": frozenset({"corp_id", "agent_id", "secret", "encoding_aes_key", "callback_host", "callback_port"}),
    "whatsapp": frozenset({"phone_number_id", "access_token", "verify_token", "webhook_host", "webhook_port"}),
    "email": frozenset(
        {"imap_host", "imap_port", "imap_ssl", "smtp_host", "smtp_port", "smtp_starttls",
         "username", "password", "mailbox", "poll_interval"}
    ),
}
_CHANNEL_PORT_KEYS = frozenset({"callback_port", "webhook_port", "imap_port", "smtp_port"})
_CHANNEL_BOOL_KEYS = frozenset({"imap_ssl", "smtp_starttls"})
_CHANNEL_INT_KEYS = frozenset({"poll_interval"})
_CHANNEL_SCALAR_KEYS = frozenset({"agent_id", "phone_number_id"})  # numeric ok, normalized to str


class ConfigError(Exception):
    """Raised for any gateway.yaml parse or validation failure."""


@dataclass(frozen=True, slots=True)
class PairingConfig:
    enabled: bool = True
    ttl_minutes: int = 60


@dataclass(frozen=True, slots=True)
class ChannelConfig:
    id: str
    token: str = ""
    allow_from: tuple[str, ...] = ()
    group_allow: tuple[str, ...] = ()
    extra: dict[str, Any] = field(default_factory=dict)  # per-channel keys (e.g. channels.wecom.corp_id)


@dataclass(frozen=True, slots=True)
class GatewayConfig:
    worker: str
    workspace: str
    worker_token: str | None = None
    channels: dict[str, ChannelConfig] = field(default_factory=dict)
    pairing: PairingConfig = field(default_factory=PairingConfig)
    cooldown_per_minute: int = 10
    uploads_dir: str = "uploads"


def resolve_config_path(explicit: str | None, workspace: Path) -> Path:
    """Config lookup: --config path → <workspace>/.rind/gateway.yaml."""
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise ConfigError(f"gateway config file not found: {path}")
        return path
    path = workspace / ".rind" / "gateway.yaml"
    if not path.is_file():
        raise ConfigError(f"gateway config file not found: {path} (use --config to point at one)")
    return path


def load_config(path: str | Path, *, env: Mapping[str, str] | None = None) -> GatewayConfig:
    """Read, parse and validate one gateway.yaml file."""
    text = Path(path).read_text(encoding="utf-8")
    data = parse_yaml(text, env=os.environ if env is None else env)
    return build_config(data)


# --- YAML subset parser ------------------------------------------------------


def parse_yaml(text: str, *, env: Mapping[str, str]) -> dict[str, Any]:
    lines = _significant_lines(text)
    if not lines:
        return {}
    value, index = _parse_mapping(lines, 0, lines[0][0], env)
    if index != len(lines):
        indent, _ = lines[index]
        raise ConfigError(f"gateway config line {index + 1}: unexpected indentation (indent {indent})")
    return value


def _significant_lines(text: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise ConfigError("gateway config: tab indentation is not supported")
        stripped = _strip_comment(raw).rstrip()
        if not stripped.strip():
            continue
        lines.append((len(stripped) - len(stripped.lstrip(" ")), stripped.strip()))
    return lines


def _strip_comment(line: str) -> str:
    quote = ""
    for index, char in enumerate(line):
        if quote:
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
        elif char == "#" and (index == 0 or line[index - 1] in " \t"):
            return line[:index]
    return line


def _parse_mapping(lines: list[tuple[int, str]], index: int, indent: int, env: Mapping[str, str]) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while index < len(lines):
        line_indent, content = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent:
            raise ConfigError(f"gateway config line {index + 1}: unexpected indentation (indent {line_indent})")
        key, separator, rest = content.partition(":")
        key = key.strip()
        if not separator or not key:
            raise ConfigError(f"gateway config line {index + 1}: expected 'key: value'")
        rest = rest.strip()
        index += 1
        if rest:
            result[key] = _parse_value(rest, env)
        elif index < len(lines) and lines[index][0] > indent:
            result[key], index = _parse_mapping(lines, index, lines[index][0], env)
        else:
            result[key] = {}
    return result, index


def _parse_value(raw: str, env: Mapping[str, str]) -> Any:
    interpolated = _interpolate(raw, env)
    if interpolated.startswith("[") and interpolated.endswith("]"):
        return tuple(_parse_inline_list(interpolated, env))
    return _parse_scalar(interpolated, env)


def _interpolate(raw: str, env: Mapping[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in env:
            raise ConfigError(f"gateway config: undefined environment variable: {name}")
        return env[name]

    return _VAR_PATTERN.sub(replace, raw)


def _split_items(body: str) -> list[str]:
    items: list[str] = []
    current: list[str] = []
    quote = ""
    depth = 0
    for char in body:
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
            current.append(char)
        elif char == "[":
            depth += 1
            current.append(char)
        elif char == "]":
            depth -= 1
            current.append(char)
        elif char == "," and depth == 0:
            items.append("".join(current))
            current = []
        else:
            current.append(char)
    if "".join(current).strip():
        items.append("".join(current))
    return items


def _parse_inline_list(raw: str, env: Mapping[str, str]) -> list[str]:
    body = raw[1:-1].strip()
    if not body:
        return []
    return [_parse_scalar(item.strip(), env) for item in _split_items(body)]


def _parse_scalar(raw: str, env: Mapping[str, str]) -> str | bool | int:
    if raw.startswith('"'):
        try:
            return str(json.loads(raw))
        except json.JSONDecodeError as exc:
            raise ConfigError(f"gateway config: invalid double-quoted string: {raw}") from exc
    if raw.startswith("'"):
        if len(raw) < 2 or not raw.endswith("'"):
            raise ConfigError(f"gateway config: invalid single-quoted string: {raw}")
        return raw[1:-1].replace("''", "'")
    if raw in ("true", "false"):
        return raw == "true"
    if _INT_PATTERN.match(raw):
        return int(raw)
    return _interpolate(raw, env)


# --- schema validation -------------------------------------------------------


def build_config(data: Mapping[str, Any]) -> GatewayConfig:
    _check_keys(data, _KNOWN_TOP_LEVEL, "")
    worker = _require_str(data, "worker")
    if worker != "stdio" and not worker.startswith(("ws://", "wss://")):
        raise ConfigError('gateway config: worker must be "stdio" or a ws:// (wss://) URL')
    workspace = _require_str(data, "workspace")
    if not os.path.isabs(workspace):
        raise ConfigError("gateway config: workspace must be an absolute path")
    worker_token = data.get("worker_token")
    if worker_token is not None and not isinstance(worker_token, str):
        raise ConfigError("gateway config: worker_token must be a string")
    pairing = _build_pairing(data.get("pairing") or {})
    cooldown = _build_cooldown(data.get("cooldown_per_minute"))
    uploads_dir = data.get("uploads_dir", "uploads")
    if not isinstance(uploads_dir, str) or not uploads_dir or os.path.isabs(uploads_dir):
        raise ConfigError('gateway config: uploads_dir must be a workspace-relative path')
    return GatewayConfig(
        worker=worker,
        workspace=workspace,
        worker_token=worker_token or None,
        channels=_build_channels(data.get("channels") or {}),
        pairing=pairing,
        cooldown_per_minute=cooldown,
        uploads_dir=uploads_dir,
    )


def _build_pairing(raw: Mapping[str, Any]) -> PairingConfig:
    _check_keys(raw, _KNOWN_PAIRING, "pairing")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ConfigError("gateway config: pairing.enabled must be true or false")
    ttl_minutes = raw.get("ttl_minutes", 60)
    if isinstance(ttl_minutes, bool) or not isinstance(ttl_minutes, int) or not 1 <= ttl_minutes <= 10080:
        raise ConfigError("gateway config: pairing.ttl_minutes must be an integer in [1, 10080]")
    return PairingConfig(enabled=enabled, ttl_minutes=ttl_minutes)


def _build_cooldown(raw: Any) -> int:
    if raw is None:
        return 10
    if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 10000:
        raise ConfigError("gateway config: cooldown_per_minute must be an integer in [1, 10000]")
    return raw


def _build_channels(raw: Mapping[str, Any]) -> dict[str, ChannelConfig]:
    channels: dict[str, ChannelConfig] = {}
    for channel_id, block in raw.items():
        if not isinstance(block, Mapping):
            raise ConfigError(f"gateway config: channels.{channel_id} must be a mapping")
        cid = str(channel_id)
        _check_keys(block, _KNOWN_CHANNEL | _CHANNEL_KEYS.get(cid, frozenset()), f"channels.{cid}")
        allow_from = _string_list(block.get("allow_from") or (), f"channels.{cid}.allow_from")
        group_allow = _string_list(block.get("group_allow") or (), f"channels.{cid}.group_allow")
        token = block.get("token") or ""
        if not isinstance(token, str):
            raise ConfigError(f"gateway config: channels.{cid}.token must be a string")
        extra = {key: _channel_value(cid, key, value) for key, value in block.items() if key not in _KNOWN_CHANNEL}
        channels[cid] = ChannelConfig(
            id=cid, token=token, allow_from=allow_from, group_allow=group_allow, extra=extra
        )
    return channels


def _channel_value(channel_id: str, key: str, raw: Any) -> Any:
    """Validate one per-channel key (types only; semantics live in the adapter)."""
    label = f"gateway config: channels.{channel_id}.{key}"
    if key in _CHANNEL_BOOL_KEYS:
        if not isinstance(raw, bool):
            raise ConfigError(f"{label} must be true or false")
        return raw
    if key in _CHANNEL_PORT_KEYS:
        if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= 65535:
            raise ConfigError(f"{label} must be an integer port in [1, 65535]")
        return raw
    if key in _CHANNEL_INT_KEYS:
        if isinstance(raw, bool) or not isinstance(raw, int) or not 5 <= raw <= 3600:
            raise ConfigError(f"{label} must be an integer seconds value in [5, 3600]")
        return raw
    if key in _CHANNEL_SCALAR_KEYS:
        if isinstance(raw, int) and not isinstance(raw, bool):
            return str(raw)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        raise ConfigError(f"{label} must be a non-empty string or integer")
    if not isinstance(raw, str) or not raw.strip():
        raise ConfigError(f"{label} must be a non-empty string")
    return raw.strip()


def _string_list(raw: Any, label: str) -> tuple[str, ...]:
    if isinstance(raw, str) or not isinstance(raw, (list, tuple)):
        raise ConfigError(f"gateway config: {label} must be a list of strings")
    for item in raw:
        if not isinstance(item, str):
            raise ConfigError(f"gateway config: {label} must contain only strings")
    return tuple(raw)


def _require_str(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if value is None:
        raise ConfigError(f"gateway config: missing required key: {key}")
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"gateway config: {key} must be a non-empty string")
    return value.strip()


def _check_keys(raw: Mapping[str, Any], known: frozenset[str], label: str) -> None:
    for key in raw:
        if key not in known:
            prefix = f"{label}." if label else ""
            raise ConfigError(f"gateway config: unknown key: {prefix}{key}")
