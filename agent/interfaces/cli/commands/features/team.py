"""Minimal team slash command for organization control."""

from __future__ import annotations

from agent.application.organization import OrganizationCoordinator

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


USAGE = "/team list | /team send <agent> <message> | /team pause <agent> | /team resume <agent> | /team show [agent]"


async def handle_team(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if not args:
        return f"Usage: {USAGE}"
    action = args[0].lower()
    store = _organization_store(context)
    if action == "list":
        if len(args) != 1:
            return f"Usage: {USAGE}"
        return _team_list(store)
    if action == "send":
        if len(args) < 3:
            return f"Usage: {USAGE}"
        return await _team_send(store, args[1], " ".join(args[2:]))
    if action == "pause":
        if len(args) != 2:
            return f"Usage: {USAGE}"
        return _team_status(store, args[1], "paused")
    if action == "resume":
        if len(args) != 2:
            return f"Usage: {USAGE}"
        return _team_status(store, args[1], "idle")
    if action == "show":
        if len(args) > 2:
            return f"Usage: {USAGE}"
        return _team_show(store, args[1] if len(args) == 2 else None)
    return f"Usage: {USAGE}"


def _organization_store(context: SlashCommandContext):
    for owner in (context.session, context.runtime):
        store = getattr(owner, "organization_store", None)
        if store is not None:
            return store
    raise RuntimeError("Team store is not configured for this session.")


def _team_list(store) -> SlashCommandResult:
    agents = store.list_agents()
    if not agents:
        return SlashCommandResult("No team agents.", display={"type": "team", "agents": []})
    lines = ["Team agents:"]
    display_agents = []
    for agent in agents:
        lines.append(f"- {agent.id} | {agent.display_name} | {agent.status} | session={agent.session_id}")
        display_agents.append(_agent_display(agent))
    return SlashCommandResult(chr(10).join(lines), display={"type": "team", "agents": display_agents})


async def _team_send(store, recipient_id: str, body: str) -> SlashCommandResult:
    coordinator = OrganizationCoordinator(store)
    message = await coordinator.send_message(sender_id="user", recipient_id=recipient_id, body=body)
    text = f"Queued message {message.id} to {recipient_id}."
    return SlashCommandResult(
        text,
        display={
            "type": "team_message",
            "message": message.to_dict(),
            "delivery": store.get_delivery(message.id, recipient_id).to_dict(),
        },
    )


def _team_status(store, agent_id: str, status: str) -> SlashCommandResult:
    agent = store.update_agent_status(agent_id, status)
    verb = "Paused" if status == "paused" else "Resumed"
    return SlashCommandResult(
        f"{verb} agent {agent.id}.",
        display={"type": "team_agent", "agent": _agent_display(agent)},
    )


def _team_show(store, agent_id: str | None) -> SlashCommandResult:
    if agent_id:
        agent = store.require_agent(agent_id)
        messages = store.list_messages(agent_id=agent.id, limit=8)
        turns = store.list_turns(agent_id=agent.id)[-8:]
        lines = [
            f"Agent {agent.id}: {agent.display_name}",
            f"Status: {agent.status}",
            f"Session: {agent.session_id}",
            f"Workspace: {agent.workspace_root}",
            "Recent messages:",
        ]
        lines.extend(_message_lines(messages))
        lines.append("Recent turns:")
        lines.extend(_turn_lines(turns))
        return SlashCommandResult(
            chr(10).join(lines),
            display={
                "type": "team_agent_detail",
                "agent": _agent_display(agent),
                "messages": [message.to_dict() for message in messages],
                "turns": [turn.to_dict() for turn in turns],
            },
        )
    messages = store.list_messages(limit=8)
    turns = store.list_turns()[-8:]
    lines = ["Recent team messages:"]
    lines.extend(_message_lines(messages))
    lines.append("Recent team turns:")
    lines.extend(_turn_lines(turns))
    return SlashCommandResult(
        chr(10).join(lines),
        display={
            "type": "team_recent",
            "messages": [message.to_dict() for message in messages],
            "turns": [turn.to_dict() for turn in turns],
        },
    )


def _message_lines(messages) -> list[str]:
    if not messages:
        return ["- none"]
    return [
        f"- {message.id} | {message.sender_id} -> {message.recipient_id} | {message.body[:80]}"
        for message in messages
    ]


def _turn_lines(turns) -> list[str]:
    if not turns:
        return ["- none"]
    return [f"- {turn.turn_id} | {turn.agent_id} | {turn.message_id} | {turn.status}" for turn in turns]


def _agent_display(agent) -> dict:
    return {
        "id": agent.id,
        "config_id": agent.config_id,
        "display_name": agent.display_name,
        "session_id": agent.session_id,
        "workspace_root": agent.workspace_root,
        "supervisor_id": agent.supervisor_id,
        "status": agent.status,
        "created_at": agent.created_at,
        "updated_at": agent.updated_at,
    }


COMMAND = SlashCommandInfo(
    name="team",
    description="Operate organization agents",
    usage=USAGE,
    handler=handle_team,
)
