"""Async Jsonl Session Store."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
import uuid
from typing import Any
from datetime import datetime, timezone

from agent.application.ports.session_store import SessionStore
from agent.infrastructure.persistence.session_files import SessionFiles
from agent.infrastructure.persistence.message_repository import MessageRepository
from agent.infrastructure.persistence.tool_call_repository import ToolCallRepository
from agent.infrastructure.persistence.compaction_repository import CompactionRepository
from agent.infrastructure.persistence.session_index_repository import SessionIndexRepository
from agent.infrastructure.persistence.message_projector import latest_compaction, project_messages
from agent.infrastructure.persistence.session_meta import (
    default_auto_compact_window,
    new_session_meta,
    normalize_auto_compact_window,
    normalize_skill_catalog,
    sync_session_counts,
)
from agent.infrastructure.paths import (
    resolve_rind_home,
    resolve_project_root,
    resolve_session_base,
    validate_session_id,
)
from agent.domain import looks_like_tool_payload
from agent.domain.goal import normalize_goal, normalize_goal_objective, normalize_goal_status


def _valid_session_id_value(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        validate_session_id(value)
    except ValueError:
        return False
    return True


class JsonlSessionStore(SessionStore):
    """
    Asynchronous JsonlSessionStore that uses specific repositories for each domain concept.
    """

    def __init__(
        self,
        session_dir: str | None = None,
        session_id: str | None = None,
        resume_latest: bool = False,
        model: str | None = None,
        system_prompt: str = "",
        workspace_root: str | None = None,
        project_id: str | None = None,
        owner_agent_id: str | None = None,
        session_type: str | None = None,
        parent_session_id: str | None = None,
        reasoning_effort: str = "",
    ):
        self._session_dir = session_dir
        self._session_id = session_id
        self._resume_latest = resume_latest
        self._model = model
        from agent.infrastructure.config.settings_loader import normalize_reasoning_effort

        self._reasoning_effort = normalize_reasoning_effort(reasoning_effort)
        self._system_prompt = system_prompt
        self._workspace_root = workspace_root
        self._project_id = project_id
        self._owner_agent_id = owner_agent_id
        self._session_type = session_type
        self._parent_session_id = parent_session_id

        self._session_root = None
        self._index_path = None
        self._session_paths = {}
        self._session_meta = None
        self._message_count = 0
        self._tool_call_count = 0
        self._has_user_message = False
        self._last_preview = ""
        self._projected_caches: dict[tuple[bool, tuple[Any, ...]], list[dict[str, Any]]] = {}
        self._files = SessionFiles()
        self._msg_repo = None
        self._tool_repo = None
        self._compaction_repo = None
        self._index_repo = None
        self._write_lock = asyncio.Lock()

    @property
    def session_id(self) -> str | None:
        return self._session_id

    @property
    def model(self) -> str | None:
        return self._model

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    @property
    def session_root(self) -> str:
        return str(self._session_root or self.resolve_session_root(self._session_dir))

    @property
    def session_base_path(self) -> str | None:
        if not self._session_id:
            return None
        base = self._session_paths.get("base")
        return str(base or resolve_session_base(self.session_root, self._session_id))

    @property
    def workspace_root(self) -> str | None:
        if isinstance(self._session_meta, dict):
            value = self._session_meta.get("workspace_root")
            if isinstance(value, str) and value.strip():
                return value
        return self._workspace_root

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    @classmethod
    def default_rind_home(cls) -> str:
        return str(resolve_rind_home())

    @classmethod
    def resolve_session_root(cls, session_dir: str | None = None) -> str:
        if session_dir:
            return os.path.abspath(os.path.expanduser(session_dir))
        return os.path.join(cls.default_rind_home(), "sessions")

    @classmethod
    def load_session_metadata(cls, session_id: str, session_dir: str | None = None) -> dict[str, Any]:
        clean = validate_session_id(session_id)
        root = cls.resolve_session_root(session_dir)
        paths = cls._metadata_paths(root, clean)
        if not os.path.isdir(paths["base"]):
            raise LookupError(f"Session not found: {clean}")
        files = SessionFiles()
        meta = files.load_json(paths["meta"])
        if not isinstance(meta, dict):
            raise ValueError(f"Session data corrupted or missing meta.json for id: {clean}")
        if str(meta.get("schema_version") or "") != "2.0":
            raise ValueError("Unsupported legacy session schema; start a new session.")
        if str(meta.get("session_id") or clean) != clean:
            raise ValueError(f"Session data corrupted: meta.json id does not match {clean}")
        return meta

    @classmethod
    def list_session_metadata(
        cls,
        session_dir: str | None = None,
        limit: int = 20,
        workspace_root: str | None = None,
    ) -> list[dict[str, Any]]:
        root = cls.resolve_session_root(session_dir)
        index_path = (
            os.path.join(root, "index.json")
            if session_dir
            else os.path.join(cls.default_rind_home(), "session_index.json")
        )
        files = SessionFiles()
        index = files.load_json(index_path) or {}
        entries = index.get("sessions") if isinstance(index, dict) else []
        if not isinstance(entries, list):
            return []
        expected_root = None
        if workspace_root:
            expected_root = os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(workspace_root))))
        result = []
        for entry in entries:
            if not isinstance(entry, dict) or not _valid_session_id_value(entry.get("id")):
                continue
            if entry.get("has_user_message") is False:
                continue
            entry_root = entry.get("workspace_root")
            if expected_root is not None:
                if not isinstance(entry_root, str):
                    continue
                normalized = os.path.normcase(os.path.realpath(os.path.abspath(entry_root)))
                if normalized != expected_root:
                    continue
            result.append(copy.deepcopy(entry))
        result.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return result[: max(0, int(limit))]

    @classmethod
    def _metadata_paths(cls, session_root: str, session_id: str) -> dict[str, str]:
        base = str(resolve_session_base(session_root, session_id))
        return {
            "base": base,
            "meta": os.path.join(base, "meta.json"),
        }

    def _resolve_workspace_root(self) -> str:
        if self._workspace_root:
            return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(self._workspace_root))))
        return os.path.normcase(os.path.realpath(str(resolve_project_root())))

    def _expected_binding(self) -> dict[str, str | None]:
        return {
            "project_id": self._project_id,
            "owner_agent_id": self._owner_agent_id,
            "session_type": self._session_type,
            "workspace_root": self._resolve_workspace_root() if self._workspace_root else None,
        }

    def _validate_session_binding(self, meta: dict[str, Any]) -> None:
        for key, expected in self._expected_binding().items():
            if expected is None:
                continue
            current = meta.get(key)
            if current != expected:
                raise ValueError(f"Session {key} is immutable and does not match the requested agent context.")

    def _setup_paths(self, create_directories: bool = False) -> None:
        self._session_root = self.resolve_session_root(self._session_dir)
        if self._session_dir:
            self._index_path = os.path.join(self._session_root, "index.json")
        else:
            self._index_path = os.path.join(self.default_rind_home(), "session_index.json")

        if create_directories:
            os.makedirs(self._session_root, exist_ok=True)
        if create_directories and self._index_path:
            os.makedirs(os.path.dirname(self._index_path), exist_ok=True)

        self._index_repo = SessionIndexRepository(self._files, self._index_path)

    def _get_session_paths(self, session_id: str, session_root: str | None = None) -> dict:
        base = str(resolve_session_base(session_root or self._session_root, session_id))
        return {
            "base": base,
            "meta": os.path.join(base, "meta.json"),
            "messages": os.path.join(base, "messages.jsonl"),
            "tool_calls": os.path.join(base, "tool_calls.jsonl"),
            "compactions": os.path.join(base, "compactions.jsonl"),
        }

    def _setup_repos(self):
        self._msg_repo = MessageRepository(self._files, self._session_paths["messages"])
        self._tool_repo = ToolCallRepository(self._files, self._session_paths["tool_calls"], looks_like_tool_payload)
        self._compaction_repo = CompactionRepository(self._files, self._session_paths["compactions"])

    def _create_session(self, session_id: str | None = None) -> None:
        if not session_id:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            session_id = f"{ts}_{uuid.uuid4().hex[:8]}"

        self._session_id = session_id
        self._session_paths = self._get_session_paths(session_id)

        os.makedirs(self._session_paths["base"], exist_ok=True)
        open(self._session_paths["messages"], "a", encoding="utf-8").close()
        open(self._session_paths["tool_calls"], "a", encoding="utf-8").close()

        self._setup_repos()
        self._invalidate_projection_cache()

        now = self.now_iso()
        self._message_count = 0
        self._tool_call_count = 0
        self._has_user_message = False

        self._session_meta = new_session_meta(
            session_id=session_id,
            now=now,
            model=self.model,
            cwd=self._resolve_workspace_root(),
            workspace_root=self._resolve_workspace_root(),
            project_id=self._project_id,
            owner_agent_id=self._owner_agent_id,
            session_type=self._session_type,
            parent_session_id=self._parent_session_id,
            reasoning_effort=self._reasoning_effort,
        )
        self._files.write_json(self._session_paths["meta"], self._session_meta)

    def _bind_draft_sync(self) -> None:
        self._session_id = None
        self._session_paths = {}
        self._session_meta = None
        self._message_count = 0
        self._tool_call_count = 0
        self._has_user_message = False
        self._last_preview = ""
        self._msg_repo = None
        self._tool_repo = None
        self._compaction_repo = None
        self._invalidate_projection_cache()

    def _load_session(self, session_id: str) -> None:
        self._session_id = session_id
        self._session_paths = self._get_session_paths(session_id)
        meta = self._files.load_json(self._session_paths["meta"])
        if not meta:
            raise ValueError(f"Session data corrupted or missing meta.json for id: {session_id}")
        if str(meta.get("schema_version") or "") != "2.0":
            raise ValueError("Unsupported legacy session schema; start a new session.")
        if str(meta.get("session_id") or session_id) != session_id:
            raise ValueError(f"Session data corrupted: meta.json id does not match {session_id}")
        self._validate_session_binding(meta)
        for key in ("messages", "tool_calls"):
            if not os.path.isfile(self._session_paths[key]):
                raise ValueError(f"Session data corrupted or missing {key}.jsonl for id: {session_id}")

        self._setup_repos()
        self._invalidate_projection_cache()

        self._session_meta = meta
        if "goal" in self._session_meta:
            self._session_meta["goal"] = normalize_goal(self._session_meta.get("goal"))
        configured_model = str(meta.get("model") or "").strip()
        self._model = configured_model or self._model
        from agent.infrastructure.config.settings_loader import normalize_reasoning_effort

        try:
            configured_effort = normalize_reasoning_effort(meta.get("reasoning_effort"))
        except ValueError:
            configured_effort = ""
        self._reasoning_effort = configured_effort or self._reasoning_effort
        original_window = self._session_meta.get("auto_compact_window")
        normalized_window = normalize_auto_compact_window(original_window)
        self._session_meta["auto_compact_window"] = normalized_window
        self._message_count = (
            self._count_persisted_messages_sync() if self._msg_repo else int(meta.get("message_count") or 0)
        )
        self._tool_call_count = (
            len(self._tool_repo.load_tool_calls()) if self._tool_repo else int(meta.get("tool_call_count") or 0)
        )
        self._has_user_message = self._has_user_message_sync()
        counts_changed = sync_session_counts(
            self._session_meta,
            message_count=self._message_count,
            tool_call_count=self._tool_call_count,
        )
        if counts_changed or original_window != normalized_window:
            self._persist_meta_sync(meta.get("updated_at"))
        self._last_preview = self._latest_assistant_preview_sync()

    def _latest_assistant_preview_sync(self) -> str:
        messages = self._msg_repo.load_messages() if self._msg_repo else []
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            content = message.get("content")
            if isinstance(content, str) and content:
                return content[:200]
        return ""

    def _count_persisted_messages_sync(self) -> int:
        messages = self._msg_repo.load_messages() if self._msg_repo else []
        return sum(
            1
            for message in messages
            if isinstance(message, dict)
            and not (
                isinstance(message.get("meta"), dict)
                and message["meta"].get("kind") in {"skill_snapshot", "skill_catalog"}
            )
        )

    def _has_user_message_sync(self) -> bool:
        messages = self._msg_repo.load_messages() if self._msg_repo else []
        return any(
            message.get("role") == "user" and str(message.get("content") or "").strip()
            for message in messages
            if isinstance(message, dict)
            and not (
                isinstance(message.get("meta"), dict)
                and message["meta"].get("kind") in {"skill_snapshot", "skill_catalog"}
            )
        )

    def _validate_existing_session_sync(self, session_id: str) -> str:
        clean = validate_session_id(session_id)
        paths = self._get_session_paths(clean)
        if not os.path.isdir(paths["base"]):
            raise ValueError(f"Session not found: {clean}")
        meta = self._files.load_json(paths["meta"])
        if not isinstance(meta, dict):
            raise ValueError(f"Session data corrupted or missing meta.json for id: {clean}")
        if str(meta.get("schema_version") or "") != "2.0":
            raise ValueError("Unsupported legacy session schema; start a new session.")
        if str(meta.get("session_id") or clean) != clean:
            raise ValueError(f"Session data corrupted: meta.json id does not match {clean}")
        for key in ("messages", "tool_calls"):
            if not os.path.isfile(paths[key]):
                raise ValueError(f"Session data corrupted or missing {key}.jsonl for id: {clean}")
        return clean

    def _switch_session_sync(self, session_id: str) -> None:
        self._setup_paths()
        clean = self._validate_existing_session_sync(session_id)
        previous = {
            "session_id": self._session_id,
            "session_paths": self._session_paths,
            "session_meta": self._session_meta,
            "message_count": self._message_count,
            "tool_call_count": self._tool_call_count,
            "last_preview": self._last_preview,
            "projected_caches": dict(self._projected_caches),
            "model": self._model,
            "reasoning_effort": self._reasoning_effort,
            "msg_repo": self._msg_repo,
            "tool_repo": self._tool_repo,
            "compaction_repo": self._compaction_repo,
            "has_user_message": self._has_user_message,
        }
        try:
            self._load_session(clean)
        except Exception:
            self._session_id = previous["session_id"]
            self._session_paths = previous["session_paths"]
            self._session_meta = previous["session_meta"]
            self._message_count = previous["message_count"]
            self._tool_call_count = previous["tool_call_count"]
            self._last_preview = previous["last_preview"]
            self._projected_caches = previous["projected_caches"]
            self._model = previous["model"]
            self._reasoning_effort = previous["reasoning_effort"]
            self._msg_repo = previous["msg_repo"]
            self._tool_repo = previous["tool_repo"]
            self._compaction_repo = previous["compaction_repo"]
            self._has_user_message = previous["has_user_message"]
            raise

    def _session_info_sync(self) -> dict[str, Any]:
        meta = self._session_meta if isinstance(self._session_meta, dict) else {}
        latest = meta.get("latest_sampling_usage")
        assistant = meta.get("latest_assistant_sampling_usage")
        return {
            "session_id": self._session_id,
            "model": self._model,
            "usage": copy.deepcopy(latest) if isinstance(latest, dict) else None,
            "assistant_usage": copy.deepcopy(assistant) if isinstance(assistant, dict) else None,
            "goal": copy.deepcopy(meta.get("goal")) if isinstance(meta.get("goal"), dict) else None,
            "project_id": meta.get("project_id"),
            "owner_agent_id": meta.get("owner_agent_id"),
            "workspace_root": meta.get("workspace_root"),
            "session_type": meta.get("session_type"),
            "parent_session_id": meta.get("parent_session_id"),
            "draft": self._session_id is None,
        }

    def _find_latest_session_id(self) -> str | None:
        index_data = self._index_repo.load_index()
        sessions = index_data.get("sessions", [])
        if not sessions:
            return None
        sessions = [
            s
            for s in sessions
            if isinstance(s, dict)
            and s.get("updated_at")
            and self._index_entry_has_user_message_sync(s)
        ]
        if not sessions:
            return None

        scoped = []
        for session in sessions:
            if not self._matches_current_workspace(session):
                continue
            session_id = session.get("id")
            if isinstance(session_id, str) and self._is_supported_session_id(session_id):
                scoped.append(session)
        if not scoped:
            return None
        scoped.sort(key=lambda s: s.get("updated_at") or "")
        return scoped[-1].get("id")

    def _index_entry_has_user_message_sync(self, entry: dict[str, Any]) -> bool:
        marker = entry.get("has_user_message")
        if isinstance(marker, bool):
            return marker
        session_id = entry.get("id")
        if not isinstance(session_id, str) or not self._is_supported_session_id(session_id):
            return False
        messages = self._files.read_jsonl(self._get_session_paths(session_id)["messages"])
        has_user_message = any(
            message.get("role") == "user" and str(message.get("content") or "").strip()
            for message in messages
            if isinstance(message, dict)
        )
        entry["has_user_message"] = has_user_message
        if self._index_repo:
            self._index_repo.update_index(entry)
        return has_user_message

    def _matches_current_workspace(self, entry: dict[str, Any]) -> bool:
        entry_root = entry.get("workspace_root")
        if not isinstance(entry_root, str) or not entry_root.strip():
            return False
        session_root = os.path.normcase(os.path.realpath(os.path.abspath(entry_root)))
        current_root = os.path.normcase(os.path.realpath(os.path.abspath(self._resolve_workspace_root())))
        return session_root == current_root

    def _is_supported_session_id(self, session_id: str) -> bool:
        try:
            meta_path = self._get_session_paths(validate_session_id(session_id))["meta"]
        except ValueError:
            return False
        meta = self._files.load_json(meta_path)
        return isinstance(meta, dict) and str(meta.get("schema_version") or "") == "2.0"

    def _update_index(self) -> None:
        if not self._index_repo or not self._session_meta:
            return

        if not self._has_user_message:
            if self._session_id:
                self._index_repo.remove_session(self._session_id)
            return

        entry = {
            "id": self._session_id,
            "title": self._session_meta.get("title", "Untitled"),
            "updated_at": self._session_meta.get("updated_at", self.now_iso()),
            "size": {"messages": self._message_count, "tool_calls": self._tool_call_count},
            "preview": self._last_preview,
            "workspace_root": self._session_meta.get("workspace_root"),
            "project_id": self._session_meta.get("project_id"),
            "owner_agent_id": self._session_meta.get("owner_agent_id"),
            "session_type": self._session_meta.get("session_type"),
            "parent_session_id": self._session_meta.get("parent_session_id"),
            "has_user_message": True,
        }
        self._index_repo.update_index(entry)

    def _persist_meta_sync(self, updated_at: str | None = None) -> None:
        if not self._session_meta or not self._session_paths:
            self._update_index()
            return
        self._session_meta["updated_at"] = updated_at or self.now_iso()
        self._files.write_json(self._session_paths["meta"], self._session_meta)
        self._update_index()

    def _invalidate_projection_cache(self) -> None:
        self._projected_caches.clear()

    def _projection_file_signature(self, path: str | None) -> tuple[int, int]:
        if not path:
            return (0, 0)
        try:
            stat = os.stat(path)
        except FileNotFoundError:
            return (0, 0)
        return (int(stat.st_size), int(stat.st_mtime_ns))

    def _projection_cache_key_sync(self) -> tuple[Any, ...]:
        paths = self._session_paths or {}
        return (
            self._system_prompt,
            self._projection_file_signature(paths.get("messages")),
            self._projection_file_signature(paths.get("tool_calls")),
            self._projection_file_signature(paths.get("compactions")),
        )

    def _projected_messages_sync(self, *, include_ids: bool = False, compacted: bool = True) -> list[dict[str, Any]]:
        key = (include_ids, compacted, self._projection_cache_key_sync())
        if key in self._projected_caches:
            return copy.deepcopy(self._projected_caches[key])

        messages = self._msg_repo.load_messages() if self._msg_repo else []
        tool_records = self._tool_repo.load_tool_calls() if self._tool_repo else []
        compactions = self._compaction_repo.load_compactions() if self._compaction_repo else []
        built_messages = project_messages(
            messages,
            tool_records,
            compactions,
            self._system_prompt,
            include_ids=include_ids,
            compacted=compacted,
        )
        self._projected_caches[key] = copy.deepcopy(built_messages)
        return copy.deepcopy(built_messages)

    def _auto_compact_window_sync(self) -> dict[str, Any]:
        if not isinstance(self._session_meta, dict):
            return default_auto_compact_window()
        normalized = normalize_auto_compact_window(self._session_meta.get("auto_compact_window"))
        self._session_meta["auto_compact_window"] = normalized
        return dict(normalized)

    def _ensure_session_sync(self):
        self._setup_paths()

        if self._session_id is not None:
            session_id = validate_session_id(self._session_id)
            session_paths = self._get_session_paths(session_id)
            if os.path.isdir(session_paths["base"]):
                self._load_session(session_id)
                return
            self._create_session(session_id)
            return

        if self._resume_latest:
            latest_id = self._find_latest_session_id()
            if latest_id and os.path.isdir(self._get_session_paths(latest_id)["base"]):
                self._load_session(latest_id)
                return
            raise ValueError("No existing session found to resume.")

        self._bind_draft_sync()

    def _initialize_history_sync(self):
        if not self._msg_repo:
            return
        messages = self._msg_repo.load_messages() if self._msg_repo else []
        has_system = any(isinstance(m, dict) and m.get("role") == "system" for m in messages)
        if not has_system and self._system_prompt:
            self._msg_repo.persist_message(self.now_iso(), "system", self._system_prompt)
            self._invalidate_projection_cache()
            self._message_count += 1
            if self._session_meta:
                self._session_meta["message_count"] = self._message_count
            self._persist_meta_sync()

    def _materialize_draft_sync(self) -> None:
        if self._session_id is not None:
            return
        self._setup_paths(create_directories=True)
        self._create_session(None)
        self._initialize_history_sync()
        from agent.infrastructure.planning.store import set_active_session_context

        set_active_session_context(str(self._session_root), str(self._session_id))

    async def initialize(self, *, persist_system_prompt: bool = True) -> None:
        async with self._write_lock:
            await asyncio.to_thread(self._ensure_session_sync)
            if persist_system_prompt:
                await asyncio.to_thread(self._initialize_history_sync)

            from agent.infrastructure.planning.store import clear_active_session_context, set_active_session_context

            if self._session_root and self._session_id:
                set_active_session_context(str(self._session_root), str(self._session_id))
            else:
                clear_active_session_context()

    async def discard_if_empty(self) -> None:
        async with self._write_lock:
            await asyncio.to_thread(self._discard_if_empty_sync)

    def _discard_if_empty_sync(self) -> None:
        if not self._session_id or not self._session_paths:
            return
        messages = self._msg_repo.load_messages() if self._msg_repo else []
        if any(
            message.get("role") == "user" and str(message.get("content") or "").strip()
            for message in messages
            if isinstance(message, dict)
            and not (
                isinstance(message.get("meta"), dict)
                and message["meta"].get("kind") in {"skill_snapshot", "skill_catalog"}
            )
        ):
            return
        base = self._session_paths.get("base")
        if not base or not os.path.isdir(base):
            return
        if self._index_repo:
            self._index_repo.remove_session(self._session_id)
        shutil.rmtree(base)

    async def switch_session(self, session_id: str) -> dict[str, Any]:
        """Switch to an existing session without creating a new one."""
        async with self._write_lock:
            await asyncio.to_thread(self._switch_session_sync, session_id)
            await asyncio.to_thread(self._initialize_history_sync)

            if self._session_root and self._session_id:
                from agent.infrastructure.planning.store import set_active_session_context

                set_active_session_context(str(self._session_root), str(self._session_id))
            return await asyncio.to_thread(self._session_info_sync)

    async def create_session(self) -> dict[str, Any]:
        """Bind a new in-memory draft without creating persistent session files."""
        async with self._write_lock:
            await asyncio.to_thread(self._setup_paths)
            await asyncio.to_thread(self._bind_draft_sync)
            from agent.infrastructure.planning.store import clear_active_session_context

            clear_active_session_context()
            return await asyncio.to_thread(self._session_info_sync)

    async def create_team_project(self, *, project_id: str | None = None) -> dict[str, Any]:
        from agent.infrastructure.team import initialize_team_project

        project = initialize_team_project(self._resolve_workspace_root(), project_id=project_id)
        return {
            "project_id": project.project_id,
            "main_agent": project.main_agent,
            "workspace_root": str(project.agents_root / project.main_agent),
        }

    async def update_model(self, model: str) -> None:
        clean = str(model or "").strip()
        if not clean:
            raise ValueError("Model name is required.")

        async with self._write_lock:
            def _persist():
                self._model = clean
                if not self._session_meta or not self._session_paths:
                    return
                self._session_meta["model"] = clean
                self._persist_meta_sync()

            await asyncio.to_thread(_persist)

    async def update_reasoning_effort(self, effort: str) -> None:
        from agent.infrastructure.config.settings_loader import normalize_reasoning_effort

        clean = normalize_reasoning_effort(effort)
        if not clean:
            raise ValueError("Reasoning effort is required.")

        async with self._write_lock:
            def _persist():
                self._reasoning_effort = clean
                if not self._session_meta or not self._session_paths:
                    return
                self._session_meta["reasoning_effort"] = clean
                self._persist_meta_sync()

            await asyncio.to_thread(_persist)

    async def get_skill_catalog(self) -> list[dict[str, str]]:
        async with self._write_lock:
            return await asyncio.to_thread(
                lambda: normalize_skill_catalog(
                    self._session_meta.get("skill_catalog") if isinstance(self._session_meta, dict) else []
                )
            )

    async def set_skill_catalog(self, entries: list[dict[str, str]]) -> None:
        normalized = normalize_skill_catalog(entries)
        async with self._write_lock:
            def _persist():
                if not self._session_meta or not self._session_paths:
                    return
                current = normalize_skill_catalog(self._session_meta.get("skill_catalog"))
                if "skill_catalog" in self._session_meta and current == normalized:
                    return
                self._session_meta["skill_catalog"] = normalized
                self._persist_meta_sync(self._session_meta.get("updated_at"))

            await asyncio.to_thread(_persist)

    async def persist_message(
        self,
        role: str,
        content: str,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        meta: dict[str, Any] | None = None,
        reasoning_content: str | None = None,
    ) -> None:
        async with self._write_lock:
            def _persist():
                is_context_record = isinstance(meta, dict) and meta.get("kind") in {
                    "skill_snapshot",
                    "skill_catalog",
                }
                if self._session_id is None:
                    if role != "user" or not str(content or "").strip() or is_context_record:
                        return
                    self._materialize_draft_sync()
                if not self._msg_repo:
                    return
                self._msg_repo.persist_message(
                    self.now_iso(),
                    role,
                    content,
                    tool_call_id,
                    tool_name,
                    meta,
                    reasoning_content,
                )
                self._invalidate_projection_cache()
                if not is_context_record:
                    self._message_count += 1
                if role == "user" and not is_context_record and str(content or "").strip():
                    self._has_user_message = True
                if role == "assistant" and content:
                    self._last_preview = content[:200]
                if (
                    role == "user"
                    and not is_context_record
                    and self._session_meta
                    and self._session_meta.get("title") in {None, "", "Untitled"}
                ):
                    self._session_meta["title"] = (content or "")[:40]
                if self._session_meta:
                    self._session_meta["message_count"] = self._message_count
                self._persist_meta_sync()

            await asyncio.to_thread(_persist)
            if self._session_root and self._session_id:
                from agent.infrastructure.planning.store import set_active_session_context

                set_active_session_context(str(self._session_root), str(self._session_id))

    async def persist_tool_call(
        self,
        call_id: str,
        name: str,
        parsed_args: dict,
        raw_args: str,
        ts_start: str,
        ts_end: str,
        result_payload: str,
        model_content: str,
        model_content_format: str | None = None,
        model_content_policy: dict[str, Any] | None = None,
    ) -> None:
        async with self._write_lock:
            def _persist():
                if not self._tool_repo:
                    return
                self._tool_repo.persist_tool_call(
                    call_id,
                    name,
                    parsed_args,
                    raw_args,
                    ts_start,
                    ts_end,
                    result_payload,
                    model_content=model_content,
                    model_content_format=model_content_format,
                    model_content_policy=model_content_policy,
                )
                self._invalidate_projection_cache()
                self._tool_call_count += 1
                if self._session_meta:
                    self._session_meta["tool_call_count"] = self._tool_call_count
                self._persist_meta_sync()

            await asyncio.to_thread(_persist)

    async def load_messages(self) -> list[dict[str, Any]]:
        def _load():
            return self._msg_repo.load_messages() if self._msg_repo else []
        return await asyncio.to_thread(_load)

    def _latest_compaction_sync(self) -> dict[str, Any] | None:
        if not self._compaction_repo or not self._msg_repo:
            return None
        return latest_compaction(
            self._msg_repo.load_messages(),
            self._compaction_repo.load_compactions(),
        )

    async def get_messages_slice(
        self,
        start: int | None = None,
        end: int | None = None,
        roles: list[str] | None = None,
        include_ids: bool = False,
        compacted: bool = True,
    ) -> list[dict[str, Any]]:
        def _get():
            built_messages = self._projected_messages_sync(include_ids=include_ids, compacted=compacted)
            if roles:
                allowed_roles = set(roles)
                built_messages = [message for message in built_messages if message.get("role") in allowed_roles]
            return [dict(message) for message in built_messages[slice(start, end)]]

        return await asyncio.to_thread(_get)

    async def get_messages_for_session(
        self,
        session_id: str,
        start: int | None = None,
        end: int | None = None,
        roles: list[str] | None = None,
        compacted: bool = True,
    ) -> list[dict[str, Any]]:
        """Project another persisted session without rebinding this store."""
        def _get():
            clean = validate_session_id(session_id)
            session_root = self.resolve_session_root(self._session_dir)
            paths = self._get_session_paths(clean, session_root)
            if not os.path.isdir(paths["base"]):
                raise ValueError(f"Session not found: {clean}")
            meta = self._files.load_json(paths["meta"])
            if not isinstance(meta, dict):
                raise ValueError(f"Session data corrupted or missing meta.json for id: {clean}")
            if str(meta.get("schema_version") or "") != "2.0":
                raise ValueError("Unsupported legacy session schema; start a new session.")
            if str(meta.get("session_id") or clean) != clean:
                raise ValueError(f"Session data corrupted: meta.json id does not match {clean}")
            self._validate_session_binding(meta)
            for key in ("messages", "tool_calls"):
                if not os.path.isfile(paths[key]):
                    raise ValueError(f"Session data corrupted or missing {key}.jsonl for id: {clean}")
            messages = MessageRepository(self._files, paths["messages"]).load_messages()
            tool_records = ToolCallRepository(self._files, paths["tool_calls"], looks_like_tool_payload).load_tool_calls()
            compactions = CompactionRepository(self._files, paths["compactions"]).load_compactions()
            projected = project_messages(
                messages,
                tool_records,
                compactions,
                self._system_prompt,
                compacted=compacted,
            )
            if roles:
                projected = [message for message in projected if message.get("role") in set(roles)]
            return [dict(message) for message in projected[slice(start, end)]]

        return await asyncio.to_thread(_get)

    async def list_recent_sessions(self, limit: int = 10) -> list[dict[str, Any]]:
        def _list():
            self._setup_paths()
            index_data = self._index_repo.load_index() if self._index_repo else {"sessions": []}
            sessions = index_data.get("sessions", [])
            sessions = [
                s
                for s in sessions
                if isinstance(s, dict)
                and s.get("updated_at")
                and _valid_session_id_value(s.get("id"))
                and self._index_entry_has_user_message_sync(s)
                and self._matches_current_workspace(s)
            ]
            sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
            return sessions[:limit]
        return await asyncio.to_thread(_list)

    async def get_tool_records(self, limit: int | None = None, call_ids: list[str] | None = None) -> list[dict[str, Any]]:
        def _get():
            if not self._tool_repo:
                return []
            records = self._tool_repo.load_tool_calls()
            if call_ids:
                allowed_ids = set(call_ids)
                records = [record for record in records if record.get("id") in allowed_ids]
            if limit is not None and limit > 0:
                records = records[-limit:]
            return records
        return await asyncio.to_thread(_get)

    async def persist_sampling_usage(self, usage: dict[str, Any]) -> None:
        async with self._write_lock:
            def _persist():
                if not self._session_meta or not self._session_paths:
                    return
                latest = dict(usage or {})
                latest["updated_at"] = self.now_iso()
                self._session_meta["latest_sampling_usage"] = latest
                if latest.get("sampling_kind") == "assistant":
                    self._session_meta["latest_assistant_sampling_usage"] = dict(latest)
                self._persist_meta_sync(latest["updated_at"])

            await asyncio.to_thread(_persist)

    async def get_latest_sampling_usage(self) -> dict[str, Any] | None:
        def _get():
            if not isinstance(self._session_meta, dict):
                return None
            usage = self._session_meta.get("latest_sampling_usage")
            return dict(usage) if isinstance(usage, dict) else None

        return await asyncio.to_thread(_get)

    async def get_latest_assistant_sampling_usage(self) -> dict[str, Any] | None:
        def _get():
            if not isinstance(self._session_meta, dict):
                return None
            usage = self._session_meta.get("latest_assistant_sampling_usage")
            return dict(usage) if isinstance(usage, dict) else None

        return await asyncio.to_thread(_get)

    async def persist_turn_state(
        self,
        turn_id: str,
        status: str,
        ts: str,
        recovery_attempt: int | None = None,
    ) -> None:
        clean_turn_id = str(turn_id or "").strip()
        clean_status = str(status or "").strip()
        if not clean_turn_id or not clean_status:
            raise ValueError("Turn state requires turn_id and status.")
        async with self._write_lock:
            def _persist():
                if not self._session_meta:
                    return
                state = {
                    "turn_id": clean_turn_id,
                    "status": clean_status,
                    "ts": str(ts or self.now_iso()),
                }
                if recovery_attempt is not None:
                    if isinstance(recovery_attempt, bool) or not isinstance(recovery_attempt, int) or recovery_attempt < 1:
                        raise ValueError("Recovery attempt must be a positive integer.")
                    state["recovery_attempt"] = recovery_attempt
                self._session_meta["turn_state"] = state
                self._persist_meta_sync()

            await asyncio.to_thread(_persist)

    async def get_turn_state(self) -> dict[str, Any] | None:
        def _get():
            state = self._session_meta.get("turn_state") if isinstance(self._session_meta, dict) else None
            return dict(state) if isinstance(state, dict) else None

        return await asyncio.to_thread(_get)

    async def get_goal(self) -> dict[str, str] | None:
        def _get():
            goal = self._session_meta.get("goal") if isinstance(self._session_meta, dict) else None
            return dict(goal) if isinstance(goal, dict) else None

        return await asyncio.to_thread(_get)

    async def set_goal(self, objective: str) -> dict[str, str]:
        normalized = normalize_goal_objective(objective)
        async with self._write_lock:
            def _persist():
                if not self._session_meta:
                    raise RuntimeError("Send a message before setting a goal for this draft session.")
                goal = {"objective": normalized, "status": "active"}
                self._session_meta["goal"] = goal
                self._persist_meta_sync()
                return dict(goal)

            return await asyncio.to_thread(_persist)

    async def set_goal_status(self, status: str) -> dict[str, str]:
        normalized_status = normalize_goal_status(status)
        async with self._write_lock:
            def _persist():
                if not self._session_meta:
                    raise RuntimeError("Session is not initialized.")
                goal = normalize_goal(self._session_meta.get("goal"))
                if goal is None:
                    raise ValueError("No active goal exists.")
                goal["status"] = normalized_status
                self._session_meta["goal"] = goal
                self._persist_meta_sync()
                return dict(goal)

            return await asyncio.to_thread(_persist)

    async def clear_goal(self) -> None:
        async with self._write_lock:
            def _persist():
                if self._session_meta is not None:
                    self._session_meta.pop("goal", None)
                    self._persist_meta_sync()

            await asyncio.to_thread(_persist)

    async def get_compact_generation(self) -> int:
        def _get():
            return int(self._auto_compact_window_sync().get("ordinal") or 1)

        return await asyncio.to_thread(_get)

    async def persist_compaction(self, compaction: dict[str, Any]) -> dict[str, Any]:
        async with self._write_lock:
            def _persist():
                if not self._compaction_repo or not self._msg_repo:
                    raise RuntimeError("Send a message before compacting this draft session.")
                candidate = dict(compaction)
                candidate.setdefault("id", uuid.uuid4().hex)
                candidate.setdefault("created_at", self.now_iso())
                candidate.setdefault("policy_version", "compact_boundary_v1")
                record = self._compaction_repo.persist_compaction(candidate)
                compact_id = record.get("id")
                self._msg_repo.persist_message(
                    self.now_iso(),
                    "assistant",
                    "",
                    meta={"kind": "compact_boundary", "compact_id": compact_id},
                )
                self._invalidate_projection_cache()
                self._message_count += 1
                if self._session_meta:
                    self._session_meta["message_count"] = self._message_count
                    self._session_meta["latest_compaction"] = {
                        "id": compact_id,
                        "created_at": record.get("created_at"),
                        "policy_version": record.get("policy_version"),
                        "source": record.get("source"),
                    }
                    self._session_meta["auto_compact_window"] = {
                        "ordinal": int(self._auto_compact_window_sync().get("ordinal") or 1) + 1,
                    }
                    self._session_meta.pop("latest_assistant_sampling_usage", None)
                self._persist_meta_sync()
                return record

            return await asyncio.to_thread(_persist)

    async def get_latest_compaction(self) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._latest_compaction_sync)
