"""Dependency injection setup for FastAPI."""

from __future__ import annotations

from typing import Any
from fastapi import Request

def get_agent_factory(request: Request) -> Any:
    """Retrieve the agent factory from app state."""
    return request.app.state.agent_factory
