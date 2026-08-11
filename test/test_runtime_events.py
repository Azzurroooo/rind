import unittest
import json
import dataclasses
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.events import (
    RuntimeEvent,
    AssistantDeltaEvent,
    ContextBuiltEvent,
    FileChangeEvent,
    TokenStatsUpdatedEvent,
    ToolRequestedEvent,
    ToolProgressEvent,
    ToolResultEvent,
    UserQuestionRequestedEvent,
    TurnStartedEvent,
    TurnCompletedEvent
)


class TestRuntimeEvents(unittest.TestCase):
    def test_event_initialization(self):
        event = AssistantDeltaEvent(text="Hello")
        self.assertEqual(event.type, "assistant_delta")
        self.assertEqual(event.text, "Hello")
        self.assertTrue(isinstance(event.ts, str))
        self.assertTrue(event.event_id)

    def test_event_serialization(self):
        event = ToolProgressEvent(tool_call_id="call_123", tool_name="bash", payload={"stdout": "test"})
        # Should be easily serializable using dataclasses.asdict
        event_dict = dataclasses.asdict(event)
        self.assertEqual(event_dict["type"], "tool_progress")
        self.assertEqual(event_dict["tool_call_id"], "call_123")
        self.assertEqual(event_dict["tool_name"], "bash")
        self.assertEqual(event_dict["payload"], {"stdout": "test"})

        # Ensure it can be dumped to JSON
        json_str = json.dumps(event_dict)
        self.assertIn("tool_progress", json_str)
        self.assertIn("call_123", json_str)

    def test_standard_event_metadata_round_trip(self):
        event = ContextBuiltEvent(
            ts="2026-05-19T00:00:00Z",
            session_id="session_1",
            turn_id="turn_1",
            message_count=3,
            stats={"estimated_input_tokens": 123},
            decisions={"mode": "test"},
        )

        restored = RuntimeEvent.from_dict(event.to_dict())

        self.assertTrue(isinstance(restored, ContextBuiltEvent))
        self.assertEqual(restored.session_id, "session_1")
        self.assertEqual(restored.turn_id, "turn_1")
        self.assertEqual(restored.message_count, 3)
        self.assertEqual(restored.stats["estimated_input_tokens"], 123)

    def test_new_runtime_events_are_serializable(self):
        events = [
            TurnStartedEvent(session_id="session_1", turn_id="turn_1", user_message_chars=5),
            ToolRequestedEvent(
                tool_call_id="call_1",
                tool_name="bash",
                args_preview='{"command":"date"}',
                arguments={"command": "date"},
            ),
            ToolResultEvent(tool_call_id="call_1", tool_name="bash", status="failed", error_type="Boom"),
            FileChangeEvent(
                tool_call_id="call_file",
                file_path="demo.txt",
                lines=[{"kind": "removed", "text": "old"}, {"kind": "added", "text": "new"}],
            ),
            TokenStatsUpdatedEvent(stats={"input_tokens": 10}),
        ]

        for event in events:
            event_dict = event.to_dict()
            self.assertTrue(event_dict["event_id"])
            restored = RuntimeEvent.from_dict(event_dict)
            self.assertEqual(restored.type, event.type)

    def test_inheritance(self):
        event = TurnCompletedEvent()
        self.assertTrue(isinstance(event, RuntimeEvent))
        self.assertEqual(event.type, "turn_completed")

    def test_user_question_requested_event_round_trip(self):
        event = UserQuestionRequestedEvent(
            ts="2026-05-19T00:00:00Z",
            session_id="session_1",
            turn_id="turn_1",
            tool_call_id="call_question",
            question="Which mode should I use?",
            options=["fast", "thorough"],
            recommended="thorough",
        )

        event_dict = event.to_dict()
        self.assertEqual(event_dict["type"], "user_question_requested")
        restored = RuntimeEvent.from_dict(event_dict)

        self.assertTrue(isinstance(restored, UserQuestionRequestedEvent))
        self.assertEqual(restored.tool_call_id, "call_question")
        self.assertEqual(restored.question, "Which mode should I use?")
        self.assertEqual(restored.options, ["fast", "thorough"])
        self.assertEqual(restored.recommended, "thorough")


if __name__ == "__main__":
    unittest.main()
