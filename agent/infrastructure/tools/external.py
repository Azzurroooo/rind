"""Optional host-supplied tool bridge; runtime knows no plugin domain."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path

from agent.infrastructure.tools.spec import ToolSpec


@dataclass(frozen=True, slots=True)
class ExternalTool:
    command: str
    args: tuple[str, ...]
    env: dict[str, str]
    name: str
    description: str
    instructions: str = ""
    enabled_tools: tuple[str, ...] | None = None

    @classmethod
    def from_json(cls, raw: str) -> ExternalTool | None:
        if not raw:
            return None
        value = json.loads(raw)
        command = value["command"]
        if not isinstance(command, str) or not Path(command).is_absolute():
            raise ValueError("External tool executable must be an absolute path.")
        args = value.get("args", [])
        env = value.get("env", {})
        enabled = value.get("enabled_tools")
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise ValueError("External tool arguments must be strings.")
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise ValueError("External tool environment must contain strings.")
        if enabled is not None and (not isinstance(enabled, list) or not all(isinstance(v, str) for v in enabled)):
            raise ValueError("External tool allowlist must contain strings.")
        return cls(command, tuple(args), env, value["name"], value["description"],
                   str(value.get("instructions", "")), tuple(enabled) if enabled is not None else None)

    def spec(self, session_id: str) -> ToolSpec:
        async def invoke(action: str, parameters: dict | None = None) -> str:
            process = await asyncio.create_subprocess_exec(
                self.command, *self.args,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, **self.env},
            )
            try:
                payload = json.dumps({"method": action, "params": parameters or {}, "runtimeSessionId": session_id}).encode()
                stdout, stderr = await asyncio.wait_for(process.communicate(payload), timeout=125)
                if process.returncode:
                    raise RuntimeError(stderr.decode(errors="replace")[-2000:] or "External tool failed.")
                result = json.loads(stdout)
                return json.dumps(result, ensure_ascii=False)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()

        return ToolSpec(name=self.name, handler=invoke, description=self.description,
                        param_descriptions={"action": "Operation name.", "parameters": "Operation parameters."})
