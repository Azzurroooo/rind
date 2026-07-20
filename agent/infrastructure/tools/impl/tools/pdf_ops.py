"""PDF parsing tool — extracts structured text (markdown) from PDF files."""

from __future__ import annotations

from pathlib import Path

from agent.application.runtime.cancellation import CancellationToken
from agent.domain import tool_cancelled, tool_error, tool_ok

_MAX_PAGES_PER_CALL = 30
_TEXT_THRESHOLD = 50  # chars — below this, page is considered scanned/image
_IMAGE_THRESHOLD = 10  # images — above this, page is treated as scanned even with text


class _PdfCancelled(Exception):
    pass


def _cancelled(token: CancellationToken | None) -> str | None:
    if token and token.is_cancelled:
        return tool_cancelled("read_pdf", token.reason)
    return None


def _raise_if_cancelled(token: CancellationToken | None) -> None:
    if token and token.is_cancelled:
        raise _PdfCancelled


def read_pdf(
    file_path: str,
    start_page: int = 1,
    end_page: int | None = None,
    force_ocr: bool = False,
    _cancellation_token: CancellationToken | None = None,
) -> str:
    """Parse a PDF file and return structured markdown text.
    Supports both text-based and image-based (scanned) PDFs.
    Tables are extracted as markdown tables. Formulas appear as text.
    :param file_path: PDF file path
    :param start_page: Start page number, 1-indexed (default 1)
    :param end_page: End page inclusive (default: to end, max 30 pages per call)
    :param force_ocr: Force OCR even for text pages
    """
    try:
        if cancelled := _cancelled(_cancellation_token):
            return cancelled
        path = Path(file_path).expanduser().resolve()
        if not path.exists():
            return tool_error("read_pdf", f"文件不存在: {file_path}", "NotFound")
        if not path.is_file():
            return tool_error("read_pdf", f"路径不是文件: {file_path}", "NotAFile")
        if path.suffix.lower() != ".pdf":
            return tool_error("read_pdf", f"仅支持PDF文件, 收到: {path.suffix}", "InvalidFormat")

        import pymupdf

        with pymupdf.open(str(path)) as doc:
            total_pages = len(doc)

            # Validate and clamp page range
            start = max(1, start_page)
            if start > total_pages:
                return tool_error(
                    "read_pdf",
                    f"起始页 {start_page} 超出总页数 ({total_pages})",
                    "PageOutOfRange",
                    meta={"total_pages": total_pages},
                )

            max_end = min(start + _MAX_PAGES_PER_CALL - 1, total_pages)
            end = min(end_page or total_pages, max_end)
            if end < start:
                end = start

            requested_pages = list(range(start - 1, end))  # 0-indexed

            # Classify only the requested slice (text length + image count)
            page_types: dict[int, str] = {}
            for i in requested_pages:
                _raise_if_cancelled(_cancellation_token)
                text = doc[i].get_text().strip()
                image_count = len(doc[i].get_images(full=True))
                is_scanned = len(text) < _TEXT_THRESHOLD or image_count > _IMAGE_THRESHOLD
                page_types[i] = "scanned" if is_scanned else "text"

            scanned_count = sum(1 for p in requested_pages if page_types.get(p, "text") == "scanned")
            needs_ocr = force_ocr or scanned_count > len(requested_pages) * 0.5

            markdown_parts = _extract_pages(
                doc,
                requested_pages,
                force_ocr=needs_ocr,
                cancellation_token=_cancellation_token,
            )

        # Enhance text pages with pdfplumber tables (separate context)
        text_page_indices = [p for p in requested_pages if page_types.get(p, "text") == "text" and not needs_ocr]
        if text_page_indices:
            _raise_if_cancelled(_cancellation_token)
            table_md = _extract_tables(path, text_page_indices, cancellation_token=_cancellation_token)
            if table_md:
                markdown_parts = markdown_parts + "\n\n### 表格数据\n\n" + table_md

        # Build output with page headers
        output_lines = [
            f"Showing pages {start} to {end} of {total_pages}:",
            f"PDF类型: {'扫描版(OCR)' if needs_ocr else '文字版'}",
            "",
        ]
        for i, page_idx in enumerate(requested_pages):
            _raise_if_cancelled(_cancellation_token)
            header = f"---\n## Page {page_idx + 1}\n---"
            content = markdown_parts[i] if i < len(markdown_parts) else ""
            output_lines.append(header)
            output_lines.append(content)
            output_lines.append("")

        return tool_ok(
            "read_pdf",
            "\n".join(output_lines),
            meta={
                "file_path": str(path.resolve()),
                "total_pages": total_pages,
                "start_page": start,
                "end_page": end,
                "pdf_type": "scanned" if needs_ocr else "text",
                "has_more": end < total_pages,
            },
        )
    except _PdfCancelled:
        if cancelled := _cancelled(_cancellation_token):
            return cancelled
        return tool_cancelled("read_pdf")
    except Exception as e:
        return tool_error("read_pdf", f"解析错误: {e}", type(e).__name__)


def _extract_pages(
    doc,
    page_indices: list[int],
    *,
    force_ocr: bool = False,
    cancellation_token: CancellationToken | None = None,
) -> list[str]:
    """Extract markdown text for specified pages, one at a time to isolate failures."""
    results: list[str] = []
    for page_idx in page_indices:
        _raise_if_cancelled(cancellation_token)
        try:
            text = _extract_single_page(
                doc,
                page_idx,
                force_ocr=force_ocr,
                cancellation_token=cancellation_token,
            )
            results.append(text)
        except _PdfCancelled:
            raise
        except Exception:
            results.append(f"[第{page_idx + 1}页: 解析失败]")
    return results


def _extract_single_page(
    doc,
    page_idx: int,
    *,
    force_ocr: bool = False,
    cancellation_token: CancellationToken | None = None,
) -> str:
    """Extract text from a single page. Uses fast render+OCR for scanned pages."""
    _raise_if_cancelled(cancellation_token)
    page = doc[page_idx]
    image_count = len(page.get_images(full=True))

    # Pages with many image fragments are scanned — skip slow pymupdf4llm
    if not force_ocr and image_count <= _IMAGE_THRESHOLD:
        try:
            import pymupdf4llm
            pages = pymupdf4llm.to_markdown(
                doc.name,
                page_chunks=True,
                pages=[page_idx],
                force_ocr=False,
            )
            _raise_if_cancelled(cancellation_token)
            text = pages[0].get("text", "").strip() if pages else ""
            if len(text) >= _TEXT_THRESHOLD:
                return text
        except _PdfCancelled:
            raise
        except Exception:
            pass

    return _ocr_page(doc, page_idx, cancellation_token=cancellation_token)


def _ocr_page(doc, page_idx: int, cancellation_token: CancellationToken | None = None) -> str:
    """Render a page to image and run RapidOCR on it. One image, one OCR call."""
    from rapidocr_onnxruntime import RapidOCR
    import numpy as np

    _raise_if_cancelled(cancellation_token)
    page = doc[page_idx]
    pix = page.get_pixmap(dpi=150)

    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)

    ocr = RapidOCR()
    _raise_if_cancelled(cancellation_token)
    result, _ = ocr(img)
    _raise_if_cancelled(cancellation_token)

    if not result:
        return f"[第{page_idx + 1}页: OCR解析失败，该页可能为纯图片或空白页]"

    lines = [item[1] for item in result if item[1]]
    return "\n\n".join(lines)


def _extract_tables(
    path: Path,
    page_indices: list[int],
    cancellation_token: CancellationToken | None = None,
) -> str:
    """Extract tables from text-based pages using pdfplumber."""
    import pdfplumber

    tables_out: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page_idx in page_indices:
            _raise_if_cancelled(cancellation_token)
            if page_idx >= len(pdf.pages):
                continue
            page = pdf.pages[page_idx]
            found = page.find_tables()
            _raise_if_cancelled(cancellation_token)
            for table in found:
                data = table.extract()
                if data and len(data) > 0:
                    tables_out.append(_format_table_md(data))

    return "\n\n".join(tables_out)


def _format_table_md(rows: list[list[str | None]]) -> str:
    """Convert a table (list of rows) to markdown format."""
    if not rows:
        return ""

    lines: list[str] = []
    header = [cell or "" for cell in rows[0]]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")

    for row in rows[1:]:
        cells = [cell or "" for cell in row]
        lines.append("| " + " | ".join(cells) + " |")

    return "\n".join(lines)
