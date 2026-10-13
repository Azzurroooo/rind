import asyncio
import inspect
import json
import os
import shlex
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
os.chdir(root)

from agent.application.context import ContextBudget, ContextEstimator, ContextManager
from agent.application.tools import ToolCallProcessor, ToolResultNormalizer
from agent.domain import ParsedToolCall
from agent.domain.events import ToolResultEvent
from agent.domain.tool_result import ToolExecutionResult
from agent.infrastructure.llm.openai_chat import OpenAIChatCompletionsClient
from agent.infrastructure.persistence import JsonlSessionStore, ToolOutputStore
from agent.infrastructure.tools.shell.tool import ShellTools
from agent.prompts import build_goal_policy_prompt, build_system_prompt


class PayloadExecutor:
    def __init__(self, payload):
        self.payload = payload

    def is_async_tool(self, name):
        return True

    async def execute_async(self, name, args, raw_args=None):
        return ToolExecutionResult(status="ok", result_str=json.dumps(self.payload, ensure_ascii=False))


class GoalSession:
    async def get_messages_slice(self, **kwargs):
        return [{"role": "system", "content": "sys"}, {"role": "user", "content": "go"}]

    async def get_goal(self):
        return {"objective": "done", "status": "complete"}


async def run():
    findings = {}
    with tempfile.TemporaryDirectory(prefix="rind-review-repro-") as temp:
        os.environ["RIND_HOME"] = temp
        store = ToolOutputStore(str(Path(temp) / "sessions"))
        shell = ShellTools(store)
        normalizer = ToolResultNormalizer()
        try:
            for label, program in (("cjk", "print('汉'*20000, end='')"), ("many_lines", "print('a\\n'*5000, end='')")):
                command = f"{shlex.quote(sys.executable)} -c {shlex.quote(program)}"
                raw = await shell.bash(command, yield_time_ms=10000, _session_id="review-shell", _workspace_root=str(root))
                payload = json.loads(raw)
                normalized = await normalizer.normalize(payload)
                findings[label] = {
                    "raw_stdout_chars": len(payload["data"]["stdout"]),
                    "raw_stdout_bytes": len(payload["data"]["stdout"].encode()),
                    "model_bytes": len(normalized.model_content.encode()),
                    "model_actual_lines": normalized.model_content.count("\n") + 1,
                    "model_has_task_id": payload["data"]["task_id"] in normalized.model_content,
                }

            command = f"{shlex.quote(sys.executable)} -c 'import time; time.sleep(2)'"
            raw = await shell.bash(command, timeout_ms=100, _session_id="review-shell", _workspace_root=str(root))
            timeout_payload = json.loads(raw)
            session = JsonlSessionStore(session_dir=str(Path(temp) / "sessions"), session_id="review-process", system_prompt="sys")
            await session.initialize()
            await session.persist_message("user", "review")
            processor = ToolCallProcessor(PayloadExecutor(timeout_payload))
            call = ParsedToolCall(call_id="review-timeout", name="bash", raw_args='{"command":"sleep"}')
            events = [event async for event in processor.execute(session, [call])]
            event = next(event for event in events if isinstance(event, ToolResultEvent))
            normalized = await normalizer.normalize(timeout_payload)
            findings["timeout"] = {"raw_status": timeout_payload["data"]["status"], "raw_reason": timeout_payload["data"]["reason"], "event_status": event.status, "event_error_type": event.error_type, "model": normalized.model_content}
            reused_timeout = [event async for event in processor.execute(session, [call])]
            reused_event = next(event for event in reused_timeout if isinstance(event, ToolResultEvent))
            findings["timeout"]["reused_event_status"] = reused_event.status
            findings["timeout"]["reused_event_error_type"] = reused_event.error_type
            findings["timeout"]["reused_event_result"] = reused_event.result

            empty = {"ok": True, "tool": "task_control", "data": {"task_id": "task-lost", "status": "lost", "reason": "Worker owner disappeared", "exit_code": None, "stdout": "", "stderr": ""}}
            findings["lost"] = (await normalizer.normalize(empty)).model_content
            paged = {"ok": True, "tool": "task_control", "data": {"task_id": "task-page", "status": "completed", "return_reason": "finished", "exit_code": 0, "stdout": "first page", "stderr": "", "start_cursor": "start-token", "next_cursor": "next-token"}, "meta": {"truncated": True, "output_path": "/tmp/output.log"}}
            findings["completed_page"] = (await normalizer.normalize(paged)).model_content

            running = {"ok": True, "tool": "bash", "data": {"task_id": "task-reused", "status": "running", "return_reason": "yield_timeout", "exit_code": None, "stdout": "ready", "stderr": "", "next_cursor": "next-token"}}
            acknowledgements = []
            class Notifications:
                request_id = None

                async def result_committed(self, session_id, name, call_id, result):
                    try:
                        acknowledgements.append(isinstance(json.loads(result).get("data"), dict))
                    except (ValueError, AttributeError):
                        acknowledgements.append(False)
            processor = ToolCallProcessor(PayloadExecutor(running), task_notifications=Notifications())
            call = ParsedToolCall(call_id="review-running", name="bash", raw_args='{"command":"server"}')
            first = [event async for event in processor.execute(session, [call])]
            reused = [event async for event in processor.execute(session, [call])]
            findings["reuse"] = {"first_result": first[-1].result, "reused_result": reused[-1].result, "structured_acknowledgements": acknowledgements}

            structured = {"ok": True, "tool": "bash", "data": {"task_id": "task-persist", "status": "completed", "return_reason": "finished", "exit_code": 0, "stdout": "x" * 10000 + "TAIL-EVIDENCE", "stderr": "", "next_cursor": "next-token"}}
            processor = ToolCallProcessor(PayloadExecutor(structured))
            call = ParsedToolCall(call_id="review-persist", name="bash", raw_args='{"command":"output"}')
            _ = [event async for event in processor.execute(session, [call])]
            record = (await session.get_tool_records(call_ids=[call.call_id]))[-1]
            result = record["result"]
            findings["persistence"] = {"stored_stdout_chars": len(result["data"]["stdout"]), "model_has_tail": "TAIL-EVIDENCE" in record["model_content"], "stored_has_tail": "TAIL-EVIDENCE" in result["data"]["stdout"], "stored_has_next_cursor": "next_cursor" in result["data"], "stored_bytes": len(json.dumps(result).encode())}

            indexed = JsonlSessionStore(session_dir=str(Path(temp) / "index-sessions"), session_id="review-index", system_prompt="sys")
            await indexed.initialize()
            write_json = indexed._files.write_json
            attempts = []
            def flaky_write(path, data):
                if str(path) == str(indexed._index_repo._index_path):
                    attempts.append(str(path))
                    if len(attempts) == 1:
                        raise OSError("simulated temporary index write failure")
                return write_json(path, data)
            indexed._files.write_json = flaky_write
            await indexed.persist_message("user", "hello")
            await indexed.persist_sampling_usage({"sampling_kind": "assistant", "input_tokens": 10})
            listed = JsonlSessionStore.list_session_metadata(str(Path(temp) / "index-sessions"))
            findings["index_retry"] = {"write_attempts": len(attempts), "listed_ids": [entry["id"] for entry in listed]}

            if "goal_policy_provider" in inspect.signature(ContextManager).parameters:
                messages = (await ContextManager(goal_policy_provider=build_goal_policy_prompt).build_messages_async(GoalSession())).messages
                findings["completed_goal_policy_present"] = any("Persistent goal execution policy:" in str(message.get("content")) for message in messages)

            def prompt(cwd):
                environment = f"\n<environment_context>\nCurrent Date: 2026-10-13\nCurrent Working Directory (Project Root): {cwd}\n</environment_context>\n"
                kwargs = {"environment": environment}
                if "workspace_root" in inspect.signature(build_system_prompt).parameters:
                    kwargs["workspace_root"] = cwd
                return build_system_prompt(**kwargs)
            client = OpenAIChatCompletionsClient(None, "gpt-4.1")
            left, right = prompt("/workspace/a"), prompt("/workspace/b")
            key = lambda text: client._build_prompt_cache_key(messages=[{"role": "system", "content": text}], tools=[])
            findings["cache_keys"] = {"a": key(left), "b": key(right), "same_template_prefix": left.split("<environment_context>")[0] == right.split("<environment_context>")[0]}
            if isinstance(getattr(type(ContextManager()), "context_window", None), property):
                from types import SimpleNamespace
                from agent.runtime.core import TurnRunner
                manager = ContextManager(estimator=ContextEstimator(ContextBudget(context_window_tokens=131072)))
                original = manager.snapshot_hard_limit()
                reduced = manager.reduce_hard_limit()
                TurnRunner._restore_context_hard_limit(SimpleNamespace(_context_manager=manager), original)
                manager.context_window = 1048576
                findings["window_after_rescue_and_switch"] = {"original_snapshot": original, "rescue_limit": reduced, "new_window": manager.context_window, "new_hard_limit": manager._estimator.budget.resolved_hard_limit_tokens()}
        finally:
            await shell.close()
    print(json.dumps(findings, ensure_ascii=False, indent=2))


asyncio.run(run())
