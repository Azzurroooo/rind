"""Bounded asynchronous output drain and independent, task-scoped cursors."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path


def encode_cursor(task_id: str, offset: int, character: int = 0) -> str:
    return base64.urlsafe_b64encode(json.dumps([task_id, offset, character]).encode()).decode()


def decode_cursor(task_id: str, cursor: str) -> tuple[int, int]:
    try:
        identity, offset, character = json.loads(base64.urlsafe_b64decode(cursor))
        if identity != task_id or type(offset) is not int or type(character) is not int or min(offset, character) < 0:
            raise ValueError()
        return offset, character
    except Exception as exc:
        raise ValueError("Invalid cursor for this task.") from exc


class TaskOutput:
    def __init__(self, path: Path, task_id: str, max_bytes: int = 32 * 1024 * 1024):
        self.path = path
        self.records_path = path.with_suffix(".jsonl")
        self.task_id = task_id
        self.max_bytes = max_bytes
        self.incomplete = ""
        self._bytes = 0
        self._sequence = 0
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=16)
        self._writer: asyncio.Task | None = None

    async def start(self) -> None:
        await asyncio.to_thread(self.path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(self.path.touch)
        await asyncio.to_thread(self.records_path.touch)
        self._writer = asyncio.create_task(self._write())

    async def append(self, stream: str, raw: bytes, text: str) -> None:
        self._sequence += 1
        if not self.incomplete:
            await self._queue.put((stream, self._sequence, raw, text))

    async def flush(self) -> None:
        await self._queue.join()

    async def close(self) -> None:
        if self._writer is not None:
            await self._queue.put(None)
            await self._writer
            self._writer = None

    async def _write(self) -> None:
        while True:
            item = await self._queue.get()
            batch = [item]
            while item is not None and len(batch) < 16 and not self._queue.empty():
                item = self._queue.get_nowait()
                batch.append(item)
            try:
                if not self.incomplete:
                    await asyncio.to_thread(self._write_batch, [row for row in batch if row is not None])
            except OSError as exc:
                self.incomplete = f"Output storage failed: {exc}"
            finally:
                for _ in batch:
                    self._queue.task_done()
            if item is None:
                return

    def _write_batch(self, batch: list) -> None:
        with self.path.open("ab") as raw_log, self.records_path.open("ab") as records:
            for stream, sequence, raw, text in batch:
                line = (json.dumps({"stream": stream, "sequence": sequence, "text": text}, ensure_ascii=False) + "\n").encode("utf-8")
                if self._bytes + len(raw) + len(line) > self.max_bytes:
                    self.incomplete = f"Task output quota reached ({self.max_bytes} bytes including output index); further output drained and discarded."
                    return
                raw_log.write(raw)
                records.write(line)
                self._bytes += len(raw) + len(line)

    async def read(self, cursor: str, max_chars: int) -> dict:
        await self.flush()
        return await asyncio.to_thread(read_output_page, self.records_path, self.task_id, cursor, max_chars)


def read_output_page(path: Path, task_id: str, cursor: str, max_chars: int) -> dict:
    offset, character = decode_cursor(task_id, cursor)
    output = {"stdout": "", "stderr": "", "records": []}
    if not path.exists():
        return {**output, "next_cursor": encode_cursor(task_id, 0), "truncated": True,
                "output_incomplete": True, "output_error": "Output log is no longer available.", "available_cursor": encode_cursor(task_id, 0)}
    with path.open("rb") as source:
        if offset > path.stat().st_size:
            raise ValueError("Cursor exceeds available output.")
        source.seek(offset)
        remaining = max_chars
        while remaining:
            start = source.tell()
            line = source.readline()
            if not line:
                break
            try:
                record = json.loads(line)
            except (ValueError, UnicodeDecodeError) as exc:
                raise ValueError("Cursor does not reference an output record.") from exc
            text = record["text"]
            if character > len(text):
                raise ValueError("Cursor exceeds output record.")
            piece = text[character:character + remaining]
            output[record["stream"]] += piece
            output["records"].append({"stream": record["stream"], "sequence": record["sequence"], "text": piece})
            remaining -= len(piece)
            character += len(piece)
            if character < len(text):
                source.seek(start)
                break
            character = 0
        next_offset = source.tell()
        truncated = next_offset < path.stat().st_size
    return {**output, "next_cursor": encode_cursor(task_id, next_offset, character), "truncated": truncated}
