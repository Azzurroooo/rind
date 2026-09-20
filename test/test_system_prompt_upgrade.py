"""Refresh only identifiable built-in rules; never rewrite historical records."""

import copy
import json
from types import SimpleNamespace

import pytest

from agent.application.context.manager import ContextManager
from agent.application.tools.executor import ToolExecutor
from agent.application.tools.processor import ToolCallProcessor
from agent.domain.events import ToolResultEvent, TurnCompletedEvent
from agent.domain.models import ModelStreamEvent
from agent.infrastructure.persistence.jsonl_session_store import JsonlSessionStore
from agent.infrastructure.persistence.message_projector import project_messages
from agent.infrastructure.tools.files.specs import build_file_tool_specs
from agent.infrastructure.tools.registry import DefaultToolRegistry
from agent.prompts import FILE_TOOL_RULES, build_system_prompt, refresh_builtin_file_rules
from agent.runtime.core.stream_parser import MessageStreamParser
from agent.runtime.core.turn_runner import TurnRunner


LEGACY_PROMPT = """
You are Rind, an advanced AI software engineer and coding agent.
<core_capabilities>
1. **File System Operations**
   - `read_file`: Read UTF-8 text file ranges with line numbers, truncation status, the next offset, and the complete file SHA-256.
   - `write_file`: Atomically create a UTF-8 text file, or replace an existing file when its latest SHA-256 matches.
   - `edit_file`: Atomically replace one exact text block in an existing UTF-8 file when its latest SHA-256 matches.
</core_capabilities>
<operational_guidelines>
3. **Execution Loop**
   - **Step 6: Edit**: Use `write_file` for new files and `edit_file` for existing files after reading the latest SHA-256.
4. **Tool Best Practices**
   - **Editing**: Read every existing target first and pass its latest `sha256` to `write_file` or `edit_file`. Never reuse a hash after a successful mutation.
   - **File mutations**: Omit `expected_sha256` only when creating a new file with `write_file`; `edit_file` always requires it and replaces one unique, exact `old_str`.
   - **Reading**: `read_file` is better than `cat` because it provides line numbers and the preimage hash required by mutation tools.
   - Preserve the user's customized database constraint here.
</operational_guidelines>
"""


def test_legacy_projection_replaces_only_builtin_rules_and_is_stable():
    suffix = "\nUser instruction: compute SHA-256 for release artifacts; expected_sha256 is my API field."
    history = [
        {"role": "system", "content": LEGACY_PROMPT + suffix},
        {"role": "system", "content": "Custom system: use SHA-256."},
        {"role": "user", "content": "Skill rules: use expected_sha256.", "meta": {"kind": "skill_snapshot"}},
    ]
    before = copy.deepcopy(history)
    result = project_messages(history, [], [], "new runtime system")
    assert result[0]["content"].endswith(suffix)
    base = result[0]["content"][:-len(suffix)]
    assert "expected_sha256" not in base and "SHA-256" not in base
    assert FILE_TOOL_RULES in base
    assert "customized database constraint" in base
    assert result[1]["content"] == history[1]["content"]
    assert result[2]["content"] == history[2]["content"]
    assert history == before
    assert project_messages(history, [], [], "new runtime system") == result
    assert refresh_builtin_file_rules(result[0]["content"]) == result[0]["content"]


@pytest.mark.parametrize("content", [
    "My own instructions: edit_file requires expected_sha256.",
    LEGACY_PROMPT.replace("You are Rind", "You are a custom agent"),
    LEGACY_PROMPT.replace("Atomically create", "My custom write policy: create"),
])
def test_unidentified_or_customized_prompt_is_not_replaced(content):
    assert refresh_builtin_file_rules(content) == content


def test_new_managed_block_refreshes_without_replacing_surrounding_context():
    prompt = build_system_prompt("/project", environment="test environment")
    outdated = prompt.replace(FILE_TOOL_RULES, "<rind_file_tool_rules>obsolete built-in contract</rind_file_tool_rules>")
    assert refresh_builtin_file_rules(outdated) == prompt


@pytest.mark.asyncio
async def test_reopen_upgrades_projection_without_rewriting_system_log(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    root = str(tmp_path / "sessions")
    store = JsonlSessionStore(session_dir=root, system_prompt=LEGACY_PROMPT)
    await store.initialize()
    await store.persist_message("user", "Continue")
    path = tmp_path / "sessions" / store.session_id / "messages.jsonl"
    before = path.read_bytes()
    reopened = JsonlSessionStore(session_dir=root, session_id=store.session_id, system_prompt=build_system_prompt(str(tmp_path), environment="test environment"))
    await reopened.initialize()
    messages = await reopened.get_messages_slice()
    assert FILE_TOOL_RULES in messages[0]["content"]
    assert "expected_sha256" not in messages[0]["content"]
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_resume_executes_pending_legacy_call_before_sampling(tmp_path, monkeypatch):
    monkeypatch.setenv("RIND_HOME", str(tmp_path / "home"))
    target = tmp_path / "target.txt"
    target.write_text("old", encoding="utf-8")
    root = str(tmp_path / "sessions")
    store = JsonlSessionStore(session_dir=root, system_prompt=LEGACY_PROMPT)
    await store.initialize()
    await store.persist_message("user", "Update the file")
    raw_args = json.dumps({"file_path": "target.txt", "old_str": "old", "new_str": "new", "expected_sha256": "obsolete"})
    await store.persist_message("assistant", "", meta={
        "tool_calls": [{"id": "pending-edit", "name": "edit_file", "raw_args": raw_args}],
    })
    reopened = JsonlSessionStore(session_dir=root, session_id=store.session_id)
    await reopened.initialize()
    registry = DefaultToolRegistry(build_file_tool_specs(tmp_path))
    requests = []

    async def stream(messages, **kwargs):
        requests.append(messages)
        yield ModelStreamEvent(kind="text_delta", text="Updated")
        yield ModelStreamEvent(kind="completed", stop_reason="stop")

    runner = TurnRunner(
        chat_client=SimpleNamespace(stream=stream),
        tool_processor=ToolCallProcessor(tool_executor=ToolExecutor(registry)),
        stream_parser=MessageStreamParser(),
        tool_schemas=registry.schemas,
        context_manager=ContextManager(),
    )
    events = [event async for event in runner.run_turn(reopened, turn_id="resume-legacy", resume=True)]
    assert isinstance(events[-1], TurnCompletedEvent)
    results = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(results) == 1 and results[0].status == "completed"
    assert target.read_text(encoding="utf-8") == "new"
    assert len(requests) == 1
    assert FILE_TOOL_RULES in requests[0][0]["content"]
    assert json.loads(requests[0][-1]["content"])["ok"] is True
    records = await reopened.get_tool_records()
    assert len(records) == 1 and records[0]["raw_args"] == raw_args
