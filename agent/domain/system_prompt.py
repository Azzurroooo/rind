"""Managed file-tool instructions and narrow legacy prompt projection."""

FILE_TOOL_RULES = """<rind_file_tool_rules>
   - All file tools use `path` for the absolute or workspace-relative file path.
   - `read_file`: Read consecutive complete UTF-8 lines. Continue at `next_offset`; a LineTooLong error requires a local character-slice read with bash/Python.
   - `write_file`: Atomically create or completely overwrite a UTF-8 text file. Use for new files or complete rewrites.
   - `edit_file`: Atomically replace one unique, exact text block. Read the target, then supply `old_str` and `new_str`. No hash parameter is required.
   - Edits and writes to the same file run in call order. Each edit sees earlier changes; a later write replaces the whole file.
</rind_file_tool_rules>"""

_CURRENT_FILE_SECTION = """   - `read_file`: Read UTF-8 text file ranges with line numbers, truncation status, and the next offset.
   - `write_file`: Atomically create or completely overwrite a UTF-8 text file.
   - `edit_file`: Atomically replace one unique, exact text block in the current UTF-8 file."""
_LEGACY_FILE_SECTION = """   - `read_file`: Read UTF-8 text file ranges with line numbers, truncation status, the next offset, and the complete file SHA-256.
   - `write_file`: Atomically create a UTF-8 text file, or replace an existing file when its latest SHA-256 matches.
   - `edit_file`: Atomically replace one exact text block in an existing UTF-8 file when its latest SHA-256 matches."""
_SUPERSEDED_LINES = frozenset({
    "   - **Editing**: Read every existing target first and pass its latest `sha256` to `write_file` or `edit_file`. Never reuse a hash after a successful mutation.",
    "   - **File mutations**: Omit `expected_sha256` only when creating a new file with `write_file`; `edit_file` always requires it and replaces one unique, exact `old_str`.",
    "   - **Reading**: `read_file` is better than `cat` because it provides line numbers and the preimage hash required by mutation tools.",
    "   - **Editing**: Read existing targets before editing. Use `edit_file` for one unique, exact `old_str` replacement; use `write_file` only for new files or complete rewrites.",
    "   - **File mutations**: Edits and writes to the same file run in call order. Each edit sees earlier changes; a later write replaces the entire file, including those changes.",
    "   - **Reading**: Use `read_file` for line numbers, bounded output, and pagination.",
})


def refresh_builtin_file_rules(content: str) -> str:
    if not content.lstrip().startswith("You are Rind, an advanced AI software engineer and coding agent.\n"):
        return content
    end = content.find("</operational_guidelines>")
    if end < 0 or "<core_capabilities>" not in content[:end]:
        return content
    base, suffix = content[:end], content[end:]
    start = base.find("<rind_file_tool_rules>")
    if start >= 0:
        stop = base.find("</rind_file_tool_rules>", start)
        if stop < 0:
            return content
        return base[:start] + FILE_TOOL_RULES + base[stop + len("</rind_file_tool_rules>"):] + suffix
    for section in (_LEGACY_FILE_SECTION, _CURRENT_FILE_SECTION):
        old = "1. **File System Operations**\n" + section
        if old in base:
            base = base.replace(old, "1. **File System Operations**\n" + FILE_TOOL_RULES, 1)
            lines = []
            for line in base.split("\n"):
                if line in _SUPERSEDED_LINES:
                    continue
                if line == "   - **Step 6: Edit**: Use `write_file` for new files and `edit_file` for existing files after reading the latest SHA-256.":
                    line = "   - **Step 6: Edit**: Read existing targets and use `edit_file` for precise changes; use `write_file` for new files or complete rewrites."
                lines.append(line)
            return "\n".join(lines) + suffix
    return content
