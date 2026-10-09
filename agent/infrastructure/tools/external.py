"""Optional host-supplied tool bridge; runtime knows no plugin domain."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path

from agent.infrastructure.tools.spec import ToolSpec


@dataclass(frozen=True, slots=True)
class HostToolDeclaration:
    name: str
    description: str
    parameters: dict


@dataclass(frozen=True, slots=True)
class ExternalTool:
    command: str
    args: tuple[str, ...]
    env: dict[str, str]
    tools: tuple[HostToolDeclaration, ...]
    instructions: str = ""
    enabled_tools: tuple[str, ...] | None = None
    lifecycle: dict | None = None
    skill_files: tuple[str, ...] = ()

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
        skill_files = value.get("skill_files", [])
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise ValueError("External tool arguments must be strings.")
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise ValueError("External tool environment must contain strings.")
        if enabled is not None and (not isinstance(enabled, list) or not all(isinstance(v, str) for v in enabled)):
            raise ValueError("External tool allowlist must contain strings.")
        if not isinstance(skill_files, list) or not all(isinstance(v, str) and Path(v).is_absolute() for v in skill_files):
            raise ValueError("External skill references must be absolute file paths.")
        return cls(command, tuple(args), env, _declarations(value.get("tools", [])),
                   str(value.get("instructions", "")), tuple(enabled) if enabled is not None else None, value.get("lifecycle"), tuple(skill_files))

    async def call(self, session_id: str, method: str, parameters: dict, env: dict | None = None) -> dict:
        process = await asyncio.create_subprocess_exec(
            self.command, *self.args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, **(self.env if env is None else env)},
        )
        try:
            payload = json.dumps({"method": method, "params": parameters, "runtimeSessionId": session_id}).encode()
            stdout, stderr = await asyncio.wait_for(process.communicate(payload), timeout=125)
            if process.returncode:
                raise RuntimeError(stderr.decode(errors="replace")[-2000:] or "External tool failed.")
            return json.loads(stdout)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def notify(self, phase: str, session_id: str, parameters: dict) -> None:
        if not self.lifecycle:
            return
        result = await self.call(session_id, self.lifecycle[phase], parameters, self.lifecycle["env"])
        if not result.get("ok"):
            raise RuntimeError(result.get("error", {}).get("message", "Execution host rejected this turn."))

    def specs(self, session_id: str) -> tuple[ToolSpec, ...]:
        return tuple(self._spec(session_id, declaration) for declaration in self.tools)

    def _spec(self, session_id: str, declaration: HostToolDeclaration) -> ToolSpec:
        async def invoke(**arguments) -> str:
            # Runtime-injected arguments (the cancellation token) stay in the runtime.
            visible = {key: value for key, value in arguments.items() if not key.startswith("_")}
            return json.dumps(await self.call(session_id, declaration.name, visible), ensure_ascii=False)

        return ToolSpec(name=declaration.name, handler=invoke, description=declaration.description, parameters=declaration.parameters)


def _declarations(raw: object) -> tuple[HostToolDeclaration, ...]:
    if not isinstance(raw, list):
        raise ValueError("External tools must be a list of declarations.")
    declarations = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("description"), str):
            raise ValueError("Each external tool needs a name and a description.")
        parameters = item.get("parameters")
        if not isinstance(parameters, dict) or parameters.get("type") != "object" or not isinstance(parameters.get("properties"), dict):
            raise ValueError(f"External tool {item['name']} needs an object parameter schema.")
        declarations.append(HostToolDeclaration(item["name"], item["description"], {"required": [], **parameters}))
    return tuple(declarations)
