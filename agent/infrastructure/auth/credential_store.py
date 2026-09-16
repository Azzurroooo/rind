"""Small, process-safe credential store for user-level provider secrets."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from filelock import FileLock

from agent.domain.models import Credential
from agent.infrastructure.paths import resolve_rind_home


class CredentialStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path or (resolve_rind_home() / "auth.json")).expanduser().resolve()
        self.lock = FileLock(str(self.path) + ".lock")

    def get(self, provider_id: str) -> Credential | None:
        value = self._read().get(provider_id)
        return _credential(value) if isinstance(value, dict) else None

    def list(self) -> list[dict[str, str]]:
        return [
            {"provider_id": provider_id, "type": str(value.get("type") or "")}
            for provider_id, value in sorted(self._read().items())
            if isinstance(value, dict) and value.get("type") in {"api_key", "oauth"}
        ]

    def set(self, provider_id: str, credential: Credential) -> None:
        if not provider_id.strip():
            raise ValueError("Provider id is required.")
        data = self._read()
        data[provider_id] = _credential_dict(credential)
        self._write(data)

    def delete(self, provider_id: str) -> bool:
        data = self._read()
        if provider_id not in data:
            return False
        del data[provider_id]
        self._write(data)
        return True

    def _read(self) -> dict[str, Any]:
        with self.lock:
            if not self.path.exists():
                return {}
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError(f"Invalid auth.json: {self.path} must contain a JSON object")
            return value

    def _write(self, data: dict[str, Any]) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(self.path.parent, 0o700)
            except OSError:
                pass
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
            temporary = Path(temporary_name)
            try:
                os.close(fd)
                temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                try:
                    os.chmod(temporary, 0o600)
                except OSError:
                    pass
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)


def _credential(value: dict[str, Any]) -> Credential | None:
    kind = value.get("type")
    if kind == "api_key" and isinstance(value.get("key"), str) and value["key"]:
        return Credential(type="api_key", key=value["key"])
    if kind == "oauth" and isinstance(value.get("access"), str) and value["access"]:
        expires = value.get("expires_at")
        return Credential(
            type="oauth",
            access=value["access"],
            refresh=str(value.get("refresh") or ""),
            expires_at=int(expires) if isinstance(expires, (int, float)) else None,
        )
    return None


def _credential_dict(credential: Credential) -> dict[str, Any]:
    if credential.type == "api_key":
        if not credential.key:
            raise ValueError("API key is required.")
        return {"type": "api_key", "key": credential.key}
    if not credential.access:
        raise ValueError("OAuth access token is required.")
    value: dict[str, Any] = {"type": "oauth", "access": credential.access}
    if credential.refresh:
        value["refresh"] = credential.refresh
    if credential.expires_at is not None:
        value["expires_at"] = credential.expires_at
    return value
