from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field


_HEAD_LIMIT = 10000
_TAIL_LIMIT = 10000
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
        return self.char_count > _HEAD_LIMIT + _TAIL_LIMIT

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

    def delta(self, cursor: int, max_chars: int) -> tuple[str, int, bool]:
        cursor = cursor if 0 <= cursor <= self.char_count else 0
        head = "".join(self.head)
        tail = "".join(self.tail)
        tail_start = self.char_count - self.tail_chars
        lost = False

        if cursor < len(head):
            delta = head[cursor:]
            if tail:
                lost = tail_start > len(head)
                delta += tail
        elif cursor < tail_start:
            delta = tail
            lost = True
        else:
            delta = tail[cursor - tail_start :]

        preview_truncated = lost or len(delta) > max_chars
        if len(delta) > max_chars:
            delta = delta[-max_chars:]
        return delta, self.char_count, preview_truncated
