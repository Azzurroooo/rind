import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.interfaces.api.routes_session import TurnRequest, run_turn


@pytest.mark.asyncio
async def test_run_turn_rejects_invalid_session_id_before_factory() -> None:
    def factory(session_id: str):
        raise AssertionError("Factory should not be called for invalid session ids.")

    with pytest.raises(HTTPException) as exc_info:
        await run_turn("../escape", TurnRequest(query="hello"), object(), factory=factory)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid session id."
