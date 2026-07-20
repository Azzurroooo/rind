import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.application.runtime.cancellation import CancellationTokenSource
from agent.infrastructure.tools.impl import TOOL_SCHEMAS
from agent.infrastructure.tools.impl.tools.file_ops import glob as glob_tool
from agent.infrastructure.tools.impl.tools.file_ops import grep, list_files, read_file
from agent.infrastructure.tools.impl.tools.pdf_ops import read_pdf


def parse_payload(raw: str) -> dict:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid payload: {raw}")
    return payload


def assert_ok(raw: str) -> dict:
    payload = parse_payload(raw)
    if payload.get("ok") is not True:
        raise AssertionError(f"Expected ok=True, got: {payload}")
    return payload


def assert_error(raw: str, error_type: str) -> dict:
    payload = parse_payload(raw)
    if payload.get("ok") is not False:
        raise AssertionError(f"Expected ok=False, got: {payload}")
    if payload.get("error_type") != error_type:
        raise AssertionError(f"Expected error_type={error_type}, got: {payload}")
    return payload


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_glob_returns_files_sizes_and_skips_noise(tmp_path: Path) -> None:
    write(tmp_path / "src" / "alpha.py", "print('a')\n")
    write(tmp_path / "src" / "beta.py", "print('b')\n")
    write(tmp_path / ".git" / "ignored.py", "print('ignored')\n")
    write(tmp_path / "node_modules" / "ignored.py", "print('ignored')\n")

    payload = assert_ok(glob_tool("**/*.py", path=str(tmp_path)))
    files = payload.get("data") or []
    paths = {item.get("path") for item in files}
    if paths != {"src/alpha.py", "src/beta.py"}:
        raise AssertionError(f"Unexpected glob paths: {files}")
    if not all(isinstance(item.get("size_bytes"), int) and item.get("size_label") for item in files):
        raise AssertionError(f"Expected size fields in glob results: {files}")


def test_glob_paginates(tmp_path: Path) -> None:
    for name in ["a.py", "b.py", "c.py"]:
        write(tmp_path / name, name)

    payload = assert_ok(glob_tool("*.py", path=str(tmp_path), max_results=1, offset=1))
    data = payload.get("data") or []
    meta = payload.get("meta") or {}
    if [item.get("path") for item in data] != ["b.py"]:
        raise AssertionError(f"Expected second file page, got: {payload}")
    if meta.get("truncated") is not True or meta.get("next_offset") != 2:
        raise AssertionError(f"Expected truncated pagination meta, got: {meta}")


def test_grep_output_modes(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle\nnope\nneedle again\n")
    write(tmp_path / "b.py", "nothing\n")
    write(tmp_path / "c.txt", "needle text\n")

    default_payload = assert_ok(grep("needle", path=str(tmp_path)))
    default_data = default_payload.get("data") or []
    if default_data != ["a.py", "c.txt"]:
        raise AssertionError(f"Expected matching files only, got: {default_payload}")

    content_payload = assert_ok(grep("needle", path=str(tmp_path), output_mode="content", max_results=1, offset=1))
    content_data = content_payload.get("data") or []
    if content_data != [{"file": "a.py", "line": 3, "text": "needle again"}]:
        raise AssertionError(f"Expected paged matching line, got: {content_payload}")

    count_payload = assert_ok(grep("needle", path=str(tmp_path), output_mode="count"))
    count_data = count_payload.get("data") or []
    if count_data != [{"file": "a.py", "count": 2}, {"file": "c.txt", "count": 1}]:
        raise AssertionError(f"Expected per-file match counts, got: {count_payload}")


def test_grep_context_streaming_keeps_adjacent_matches(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle one\nneedle two\nplain\n")

    payload = assert_ok(grep("needle", path=str(tmp_path), output_mode="content", context=1))
    data = payload.get("data") or []
    lines = [item.get("line") for item in data]
    if lines != [1, 2]:
        raise AssertionError(f"Expected adjacent matches to be reported, got: {payload}")
    if not all("context" in item for item in data):
        raise AssertionError(f"Expected context records, got: {payload}")
    second_context = data[1].get("context") or []
    if second_context[:2] != [
        {"line": 1, "text": "needle one", "match": False},
        {"line": 2, "text": "needle two", "match": True},
    ]:
        raise AssertionError(f"Expected second match to keep prior context, got: {payload}")


def test_grep_rejects_invalid_inputs(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle\n")
    assert_error(grep("[", path=str(tmp_path)), "InvalidRegex")
    assert_error(grep("needle", path=str(tmp_path), output_mode="bad"), "InvalidOutputMode")


def test_read_file_paginates_with_meta(tmp_path: Path) -> None:
    file_path = tmp_path / "sample.py"
    write(file_path, "one\ntwo\nthree\nfour\n")

    payload = assert_ok(read_file(str(file_path), offset=2, limit=2))
    data = payload.get("data") or ""
    meta = payload.get("meta") or {}
    if "   2 | two" not in data or "   3 | three" not in data or "   4 | four" in data:
        raise AssertionError(f"Unexpected read_file data: {payload}")
    expected = {"shown_start": 2, "shown_end": 3, "total_lines": 4, "total_lines_exact": False, "truncated": True, "next_offset": 4}
    for key, value in expected.items():
        if meta.get(key) != value:
            raise AssertionError(f"Expected meta[{key}]={value}, got: {meta}")

    exact_payload = assert_ok(read_file(str(file_path), offset=2, limit=2, include_total=True))
    exact_meta = exact_payload.get("meta") or {}
    if exact_meta.get("total_lines") != 4 or exact_meta.get("total_lines_exact") is not True:
        raise AssertionError(f"Expected exact total line count, got: {exact_payload}")

    assert_error(read_file(str(file_path), offset=20, limit=2), "OffsetOutOfRange")


def test_sync_file_tools_return_cancelled_payload(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle\n")
    source = CancellationTokenSource()
    source.cancel("unit test")

    assert_error(read_file(str(tmp_path / "a.py"), _cancellation_token=source.token), "Cancelled")
    assert_error(glob_tool("*.py", path=str(tmp_path), _cancellation_token=source.token), "Cancelled")
    assert_error(grep("needle", path=str(tmp_path), _cancellation_token=source.token), "Cancelled")


def test_list_files_recursive_applies_pattern(tmp_path: Path) -> None:
    write(tmp_path / "src" / "alpha.py", "print('a')\n")
    write(tmp_path / "src" / "notes.txt", "notes\n")

    payload = assert_ok(list_files(str(tmp_path), pattern="*.py", recursive=True, max_depth=3))
    data = payload.get("data") or ""
    if "alpha.py" not in data:
        raise AssertionError(f"Expected matching Python file, got: {payload}")
    if "notes.txt" in data:
        raise AssertionError(f"Did not expect non-matching text file, got: {payload}")


def test_list_files_can_include_hidden_entries(tmp_path: Path) -> None:
    write(tmp_path / ".docs" / "audit.md", "notes\n")
    write(tmp_path / "visible.txt", "visible\n")

    hidden_default = assert_ok(list_files(str(tmp_path), recursive=False)).get("data") or ""
    if ".docs" in hidden_default:
        raise AssertionError(f"Did not expect hidden directory by default, got: {hidden_default}")

    included = assert_ok(list_files(str(tmp_path), recursive=False, include_hidden=True))
    data = included.get("data") or ""
    meta = included.get("meta") or {}
    if ".docs" not in data or "visible.txt" not in data:
        raise AssertionError(f"Expected hidden and visible entries, got: {included}")
    if meta.get("include_hidden") is not True:
        raise AssertionError(f"Expected include_hidden metadata, got: {meta}")


def test_read_pdf_expands_user_home_before_format_validation(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    write(home / "sample.txt", "not a pdf\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))

    assert_error(read_pdf("~/sample.txt"), "InvalidFormat")


def test_schema_includes_glob_and_grep_output_mode_enum() -> None:
    schemas = {item["function"]["name"]: item["function"] for item in TOOL_SCHEMAS}
    if "glob" not in schemas:
        raise AssertionError("Expected glob tool schema.")
    output_mode = schemas["grep"]["parameters"]["properties"].get("output_mode") or {}
    if output_mode.get("enum") != ["files_with_matches", "content", "count"]:
        raise AssertionError(f"Expected grep output_mode enum, got: {output_mode}")
    include_hidden = schemas["list_files"]["parameters"]["properties"].get("include_hidden") or {}
    if include_hidden.get("type") != "boolean":
        raise AssertionError(f"Expected list_files include_hidden boolean, got: {include_hidden}")


def test_schema_includes_ask_user_question_with_only_question_required() -> None:
    schemas = {item["function"]["name"]: item["function"] for item in TOOL_SCHEMAS}
    schema = schemas.get("ask_user_question")
    if not schema:
        raise AssertionError("Expected ask_user_question tool schema.")
    parameters = schema["parameters"]
    properties = parameters["properties"]
    if parameters.get("required") != ["question"]:
        raise AssertionError(f"Expected only question to be required, got: {parameters.get('required')}")
    if set(properties) != {"question", "options", "recommended"}:
        raise AssertionError(f"Unexpected ask_user_question properties, got: {properties}")
    if properties["options"].get("type") != "array" or properties["options"].get("items", {}).get("type") != "string":
        raise AssertionError(f"Expected string-array options schema, got: {properties['options']}")


def main() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as temp_dir:
        test_glob_returns_files_sizes_and_skips_noise(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_glob_paginates(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_grep_output_modes(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_grep_context_streaming_keeps_adjacent_matches(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_grep_rejects_invalid_inputs(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_read_file_paginates_with_meta(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_sync_file_tools_return_cancelled_payload(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_list_files_recursive_applies_pattern(Path(temp_dir))
    with tempfile.TemporaryDirectory() as temp_dir:
        test_list_files_can_include_hidden_entries(Path(temp_dir))
    test_schema_includes_glob_and_grep_output_mode_enum()
    test_schema_includes_ask_user_question_with_only_question_required()
    print("File navigation tool tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
