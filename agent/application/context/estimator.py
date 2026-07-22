"""Context size estimation and budget evaluation."""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import asdict, dataclass


logger = logging.getLogger(__name__)


DEFAULT_CONTEXT_WINDOW_TOKENS = 200000
DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT = 90


@dataclass(slots=True)
class ContextBudget:
    hard_limit_tokens: int | None = None
    system_budget_tokens: int = 2000
    conversation_budget_tokens: int = 6000
    tool_budget_tokens: int = 20000
    context_window_tokens: int = DEFAULT_CONTEXT_WINDOW_TOKENS
    auto_compact_token_limit_percent: int = DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT
    auto_compact_enabled: bool = True

    @classmethod
    def default(cls) -> "ContextBudget":
        return cls()

    def to_dict(self) -> dict:
        data = asdict(self)
        data["hard_limit_tokens"] = self.resolved_hard_limit_tokens()
        data["context_window_tokens"] = self.resolved_context_window_tokens()
        data["auto_compact_token_limit_percent"] = self.resolved_auto_compact_token_limit_percent()
        data["auto_compact_token_limit"] = self.resolved_auto_compact_token_limit()
        return data

    def resolved_context_window_tokens(self) -> int:
        return self._positive_int_or_default(self.context_window_tokens, DEFAULT_CONTEXT_WINDOW_TOKENS)

    def resolved_auto_compact_token_limit_percent(self) -> int:
        percent = self._positive_int_or_default(
            self.auto_compact_token_limit_percent,
            DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_PERCENT,
        )
        return min(100, percent)

    def resolved_auto_compact_token_limit(self) -> int:
        return max(1, self.resolved_context_window_tokens() * self.resolved_auto_compact_token_limit_percent() // 100)

    def resolved_hard_limit_tokens(self) -> int:
        if self.hard_limit_tokens is not None:
            return self._positive_int_or_default(self.hard_limit_tokens, self.resolved_context_window_tokens())
        return self.resolved_context_window_tokens()

    def _positive_int_or_default(self, value, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return max(1, int(default))
        if parsed <= 0:
            return max(1, int(default))
        return parsed


@dataclass(slots=True)
class ContextEstimate:
    message_count: int
    estimated_input_tokens: int
    estimated_chars: int
    system_tokens: int
    conversation_tokens: int
    tool_tokens: int
    over_hard_limit: bool

    def to_dict(self) -> dict:
        return asdict(self)


class ContextEstimator:
    """Estimate context size using exact tokenization or fallback heuristics."""

    def __init__(self, budget: ContextBudget | None = None):
        self._budget = budget or ContextBudget.default()
        self._tokenizer = self._get_tokenizer()
        self._cjk_pattern = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\U00020000-\U0002a6df\U0002a700-\U0002ebef\U00030000-\U000323af]')

    @property
    def budget(self) -> ContextBudget:
        return self._budget

    def _get_tokenizer(self):
        try:
            import tiktoken
            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None

    def estimate_messages(self, messages: list[dict]) -> ContextEstimate:
        system_tokens = 0
        conversation_tokens = 0
        tool_tokens = 0

        system_chars = 0
        conversation_chars = 0
        tool_chars = 0

        for message in messages:
            tokens, chars = self._estimate_message_tokens(message)
            if message.get("role") == "system":
                system_tokens += tokens
                system_chars += chars
            elif message.get("role") == "tool" or bool(message.get("tool_calls")):
                tool_tokens += tokens
                tool_chars += chars
            else:
                conversation_tokens += tokens
                conversation_chars += chars

        estimated_tokens = system_tokens + conversation_tokens + tool_tokens
        estimated_chars = system_chars + conversation_chars + tool_chars

        return ContextEstimate(
            message_count=len(messages),
            estimated_input_tokens=estimated_tokens,
            estimated_chars=estimated_chars,
            system_tokens=system_tokens,
            conversation_tokens=conversation_tokens,
            tool_tokens=tool_tokens,
            over_hard_limit=estimated_tokens >= self._budget.resolved_hard_limit_tokens(),
        )

    def _estimate_message_tokens(self, message: dict) -> tuple[int, int]:
        try:
            payload = json.dumps(message, ensure_ascii=False)
        except TypeError:
            payload = str(message)

        chars = len(payload)

        if self._tokenizer:
            try:
                tokens = len(self._tokenizer.encode(payload, disallowed_special=()))
                return tokens, chars
            except Exception:
                logger.debug("Tokenizer failed; using heuristic context estimate.", exc_info=True)

        if self._cjk_pattern.search(payload):
            tokens = int(math.ceil(chars / 1.5))
        else:
            tokens = int(math.ceil(chars / 3.5))

        return tokens, chars
