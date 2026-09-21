"""Bounded decoding and normalization of local images."""

from __future__ import annotations

import asyncio
import io
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from agent.domain.cancellation import CancellationToken
from agent.domain.errors import ProviderError

MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_IMAGE_EDGE = 2000
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"})


def is_image_file(path: Path, sample: bytes) -> bool:
    return (path.suffix.lower() in IMAGE_SUFFIXES or sample.startswith(
        (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"BM")
    ) or (sample.startswith(b"RIFF") and sample[8:12] == b"WEBP"))


def check_cancelled(token: CancellationToken | None) -> None:
    if token is not None and token.is_cancelled:
        raise asyncio.CancelledError(token.reason)


def process_image(path: str, token: CancellationToken | None = None) -> tuple[bytes, str, int, int, str]:
    check_cancelled(token)
    with Path(path).open("rb") as source:
        data = source.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise ProviderError("Image exceeds the 20 MiB source limit.", status="rejected", code="ImageTooLarge")
    check_cancelled(token)
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP", "GIF", "BMP"}:
                raise ProviderError("Use PNG, JPEG, WebP, GIF or BMP.", status="rejected", code="UnsupportedImage")
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ProviderError("Image exceeds the 40 million pixel limit.", status="rejected", code="ImageTooLarge")
            first_frame = getattr(source, "n_frames", 1) > 1
            source.seek(0)
            original = source.size
            rotated = ImageOps.exif_transpose(source)
            transparent = "A" in rotated.getbands() or "transparency" in rotated.info
            normalized = rotated.convert("RGBA" if transparent else "RGB")
            normalized.info.clear()
            check_cancelled(token)
            normalized.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
            hints = ["First frame only."] if first_frame else []
            if normalized.size != original:
                hints.append(f"Original {original[0]}x{original[1]}; sent {normalized.width}x{normalized.height}.")
            for edge, quality in ((2000, 90), (1600, 80), (1200, 70), (800, 65)):
                check_cancelled(token)
                normalized.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                use_png = transparent or (source.format != "JPEG" and edge == 2000)
                normalized.save(output, format="PNG" if use_png else "JPEG", **({} if use_png else {"quality": quality}))
                payload = output.getvalue()
                if len(payload) <= MAX_IMAGE_BYTES:
                    if edge != 2000:
                        hints.append(f"Reduced to {normalized.width}x{normalized.height} to fit the image limit.")
                    check_cancelled(token)
                    return payload, "image/png" if use_png else "image/jpeg", normalized.width, normalized.height, " ".join(hints)
            raise ProviderError("Image could not fit the 3 MiB output limit. Use a smaller image.", status="rejected", code="ImageTooLarge")
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError) as exc:
        raise ProviderError("Image cannot be decoded. Use a valid PNG, JPEG, WebP, GIF or BMP.", status="rejected", code="InvalidImage") from exc
