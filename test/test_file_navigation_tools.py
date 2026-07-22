import json
import os
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.cancellation import CancellationTokenSource
from agent.infrastructure.tools import DefaultToolRegistry
from agent.infrastructure.tools.builtin.files.operations import glob as glob_tool
from agent.infrastructure.tools.builtin.files.operations import grep, read_file
from agent.infrastructure.tools.builtin.pdf import read_pdf


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
    if not all(set(item) == {"path", "size_bytes"} for item in files):
        raise AssertionError(f"Expected compact file entries: {files}")


def test_glob_limits_results(tmp_path: Path) -> None:
    for name in ["a.py", "b.py", "c.py"]:
        write(tmp_path / name, name)

    payload = assert_ok(glob_tool("*.py", path=str(tmp_path), max_results=2))
    if [item["path"] for item in payload["data"]] != ["a.py", "b.py"]:
        raise AssertionError(f"Unexpected glob result: {payload}")
    if payload["meta"].get("truncated") is not True:
        raise AssertionError(f"Expected truncated glob result: {payload}")


def test_grep_returns_matching_lines_and_honors_glob(tmp_path: Path) -> None:
    if shutil.which("rg") is None:
        raise AssertionError("rg is required for grep")
    write(tmp_path / "a.py", "needle\nnope\nneedle again\n")
    write(tmp_path / "b.py", "nothing\n")
    write(tmp_path / "c.txt", "needle text\n")

    payload = assert_ok(grep("needle", path=str(tmp_path), glob="**/*.py"))
    if payload["data"] != [
        {"file": "a.py", "line": 1, "text": "needle"},
        {"file": "a.py", "line": 3, "text": "needle again"},
    ]:
        raise AssertionError(f"Unexpected grep result: {payload}")


def test_grep_limits_results_and_rejects_invalid_pattern(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle\nneedle again\n")
    payload = assert_ok(grep("needle", path=str(tmp_path), max_results=1))
    if len(payload["data"]) != 1 or payload["meta"].get("truncated") is not True:
        raise AssertionError(f"Expected truncated grep result: {payload}")
    assert_error(grep("[", path=str(tmp_path)), "InvalidPattern")


def test_read_file_paginates_with_encoding_and_next_offset(tmp_path: Path) -> None:
    file_path = tmp_path / "sample.py"
    write(file_path, "one\ntwo\nthree\nfour\n")

    payload = assert_ok(read_file(str(file_path), offset=2, limit=2))
    if "   2 | two" not in payload["data"] or "   3 | three" not in payload["data"]:
        raise AssertionError(f"Unexpected read_file data: {payload}")
    if "   4 | four" in payload["data"]:
        raise AssertionError(f"Read beyond requested range: {payload}")
    expected = {"offset": 2, "limit": 2, "truncated": True, "next_offset": 4, "encoding": "utf-8"}
    for key, value in expected.items():
        if payload["meta"].get(key) != value:
            raise AssertionError(f"Expected meta[{key}]={value}, got: {payload}")

    next_page = assert_ok(read_file(str(file_path), offset=payload["meta"]["next_offset"], limit=2))
    if "   4 | four" not in next_page["data"] or next_page["meta"].get("truncated") is not False:
        raise AssertionError(f"Expected next read page, got: {next_page}")


def test_read_file_rejects_missing_directory_binary_encoding_and_large_files(tmp_path: Path) -> None:
    assert_error(read_file(str(tmp_path / "missing.txt")), "NotFound")
    assert_error(read_file(str(tmp_path)), "NotAFile")

    binary_path = tmp_path / "binary.dat"
    binary_path.write_bytes(b"header\x00payload")
    assert_error(read_file(str(binary_path)), "BinaryFile")

    invalid_path = tmp_path / "invalid.txt"
    invalid_path.write_bytes(b"valid\xfftext")
    assert_error(read_file(str(invalid_path)), "InvalidEncoding")

    large_path = tmp_path / "large.txt"
    with large_path.open("wb") as handle:
        handle.truncate(10 * 1024 * 1024 + 1)
    assert_error(read_file(str(large_path)), "FileTooLarge")


def test_read_file_rejects_invalid_offset_and_honors_limit_cap(tmp_path: Path) -> None:
    file_path = tmp_path / "sample.txt"
    write(file_path, "one\ntwo\n")
    assert_error(read_file(str(file_path), offset=20), "OffsetOutOfRange")

    payload = assert_ok(read_file(str(file_path), limit=5000))
    if payload["meta"].get("limit") != 2000:
        raise AssertionError(f"Expected capped read limit, got: {payload}")


def test_sync_file_tools_return_cancelled_payload(tmp_path: Path) -> None:
    write(tmp_path / "a.py", "needle\n")
    source = CancellationTokenSource()
    source.cancel("unit test")

    assert_error(read_file(str(tmp_path / "a.py"), _cancellation_token=source.token), "Cancelled")
    assert_error(glob_tool("*.py", path=str(tmp_path), _cancellation_token=source.token), "Cancelled")
    assert_error(grep("needle", path=str(tmp_path), _cancellation_token=source.token), "Cancelled")


def test_read_pdf_expands_user_home_before_format_validation(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    write(home / "sample.txt", "not a pdf\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))

    assert_error(read_pdf("~/sample.txt"), "InvalidFormat")


def test_schema_exposes_only_minimal_file_navigation_fields() -> None:
    schemas = {item["function"]["name"]: item["function"] for item in DefaultToolRegistry().schemas}
    if "list_files" in schemas:
        raise AssertionError("list_files should not be registered")
    expected = {
        "read_file": {"path", "offset", "limit"},
        "glob": {"pattern", "path", "max_results"},
        "grep": {"pattern", "path", "glob", "max_results"},
    }
    for name, fields in expected.items():
        actual = set(schemas[name]["parameters"]["properties"])
        if actual != fields:
            raise AssertionError(f"Unexpected {name} schema fields: {actual}")


def main() -> int:
    import tempfile

    tests = [
        test_glob_returns_files_sizes_and_skips_noise,
        test_glob_limits_results,
        test_grep_returns_matching_lines_and_honors_glob,
        test_grep_limits_results_and_rejects_invalid_pattern,
        test_read_file_paginates_with_encoding_and_next_offset,
        test_read_file_rejects_missing_directory_binary_encoding_and_large_files,
        test_read_file_rejects_invalid_offset_and_honors_limit_cap,
        test_sync_file_tools_return_cancelled_payload,
    ]
    for test in tests:
        with tempfile.TemporaryDirectory() as temp_dir:
            test(Path(temp_dir))
    test_schema_exposes_only_minimal_file_navigation_fields()
    print("File navigation tool tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
