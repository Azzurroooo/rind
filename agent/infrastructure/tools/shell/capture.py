from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field


_HEAD_LIMIT = 24 * 1024
_TAIL_LIMIT = 24 * 1024
_MAX_LINES = 2000
_OUTPUT_TRUNCATED = "\n\n...[OUTPUT TRUNCATED]...\n\n"


@dataclass(slots=True)
class StreamCapture:
    head: list[str] = field(default_factory=list)
    tail: deque[str] = field(default_factory=deque)
    char_count: int = 0
    tail_chars: int = 0
    byte_count: int = 0
    newline_count: int = 0
    last_byte: int | None = None

    @property
    def line_count(self) -> int:
        return self.newline_count + int(self.byte_count > 0 and self.last_byte != 10)

    @property
    def truncated(self) -> bool:
        return self.char_count > _HEAD_LIMIT + _TAIL_LIMIT or self.line_count > _MAX_LINES

    def append(self, raw: bytes, text: str) -> None:
        if raw:
            self.byte_count += len(raw)
            self.newline_count += raw.count(b"\n")
            self.last_byte = raw[-1]
        if not text:
            return

        previous_chars = self.char_count
        self.char_count += len(text)
        head_space = max(0, _HEAD_LIMIT - previous_chars)
        if head_space:
            self.head.append(text[:head_space])
            text = text[head_space:]
        if not text:
            return

        self.tail.append(text)
        self.tail_chars += len(text)
        overflow = self.tail_chars - _TAIL_LIMIT
        while overflow > 0:
            first = self.tail[0]
            if len(first) <= overflow:
                self.tail.popleft()
                self.tail_chars -= len(first)
                overflow -= len(first)
            else:
                self.tail[0] = first[overflow:]
                self.tail_chars -= overflow
                overflow = 0

    def render(self) -> str:
        head = "".join(self.head)
        if self.char_count <= _HEAD_LIMIT:
            return head
        tail = "".join(self.tail)
        if not self.truncated:
            return head + tail
        return head + _OUTPUT_TRUNCATED + tail
