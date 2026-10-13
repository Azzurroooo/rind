"""Stable OpenAI cache affinity and compatible endpoint rejection handling."""

import hashlib


def prompt_cache_key(session_id: str) -> str:
    return "rind:" + hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:24]


def rejects_prompt_cache_key(exc: Exception) -> bool:
    text = str(exc).lower()
    return "prompt_cache_key" in text and any(
        marker in text for marker in ("unsupported", "unknown", "invalid", "unrecognized", "not support", "extra_forbidden")
    )
