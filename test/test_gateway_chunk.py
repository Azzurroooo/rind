import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from gateway.chunk import degrade_markdown, first_line_title, render_choices, split_text, unit_length


def test_short_text_is_a_single_clean_piece():
    assert split_text("你好，世界", 4000) == ["你好，世界"]
    assert split_text("", 4000) == [""]


def test_blank_line_paragraphs_split_when_over_cap():
    text = "a" * 80 + "\n\n" + "b" * 80 + "\n\n" + "c" * 80
    pieces = split_text(text, 300)  # cap 100 → paragraphs cannot share a piece
    assert pieces == ["a" * 80, "b" * 80, "c" * 80]


def test_fenced_code_stays_intact_across_blank_lines():
    fenced = "```python\nline1\n\nline3\n\nline5\n```"
    text = f"前言说明。\n\n{fenced}\n\n结尾。"
    pieces = split_text(text, 400 + 200)
    assert len(pieces) == 1
    assert pieces[0].count("```") == 2
    assert "line1\n\nline3" in pieces[0]


def test_long_fenced_text_lands_whole_in_one_piece():
    code_block = "```py\n" + "x = 1\n" * 30 + "```"
    pieces = split_text(code_block, 400 + 200)
    assert len(pieces) == 1
    assert pieces[0].startswith("```py")
    assert pieces[0].endswith("```")


def test_sentence_fallback_splits_over_limit_paragraph():
    text = "第一句。第二句。" * 60  # 480 chars > cap 400 (600 - 200 title reserve)
    pieces = split_text(text, 400 + 200)
    assert len(pieces) > 1
    assert all(len(piece) <= 400 for piece in pieces)
    assert "".join(pieces) == text


def test_utf16_hard_cut_never_splits_surrogate_pairs():
    emoji = "\U0001F600"  # astral: 1 codepoint, 2 UTF-16 code units
    text = emoji * 150  # 300 utf16 units, 150 chars
    pieces = split_text(text, 250, "utf16")  # cap = 50 utf16 units
    total = 0
    for piece in pieces:
        assert unit_length(piece, "utf16") <= 50
        for char in piece:  # every codepoint arrives whole — no lone surrogates
            assert not (0xD800 <= ord(char) <= 0xDFFF)
        total += unit_length(piece, "utf16")
    assert total == 300
    assert "".join(pieces) == text


def test_chars_unit_counts_codepoints():
    text = "字" * 250
    pieces = split_text(text, 400, "chars")  # cap = 200 codepoints
    assert [len(piece) for piece in pieces] == [200, 50]


def test_markdown_degrade_strips_markup_keeps_code_indent():
    text = "# 标题\n**加粗** 与 __下划线__\n[链接文字](https://example.com)\n```py\nprint(1)\n\nprint(2)\n```"
    plain = degrade_markdown(text)
    assert "标题" in plain and "#" not in plain.splitlines()[0]
    assert "加粗" in plain and "**" not in plain and "__" not in plain
    assert "链接文字" in plain and "](https" not in plain
    indented = [line for line in plain.splitlines() if line.startswith("    ")]
    assert "    print(1)" in indented and "    print(2)" in indented


def test_render_choices_truncates_after_five():
    rendered = render_choices(("a", "b", "c", "d", "e", "f", "g"))
    assert rendered.splitlines() == ["1. a", "2. b", "3. c", "4. d", "5. e", "（其余 2 项略）", "", "回复数字即可"]
    assert render_choices(("a", "b")).splitlines() == ["1. a", "2. b", "", "回复数字即可"]


def test_cap_leaves_title_reserve():
    text = "x" * 500
    pieces = split_text(text, 400)
    assert max(len(piece) for piece in pieces) <= 400 - 200


def test_first_line_title_is_truncated():
    assert first_line_title("任务标题\n第二行") == "任务标题"
    assert first_line_title("长" * 100) == "长" * 48
    assert first_line_title("   ") == ""
