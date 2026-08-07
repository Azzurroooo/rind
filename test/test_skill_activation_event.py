import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain import events


def test_skill_activation_event_is_not_part_of_the_runtime_protocol() -> None:
    assert not hasattr(events, "SkillActivatedEvent")
