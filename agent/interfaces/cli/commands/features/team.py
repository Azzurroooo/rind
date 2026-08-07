"""Team commands scoped to a registered Team Agent runtime."""

from __future__ import annotations

from agent.application.organization import OrganizationCoordinator

from ..router import SlashCommandContext, SlashCommandInfo, SlashCommandResult


USAGE = "/team create [project-id] | /team list | /team send <agent> <message> | /team pause <agent> | /team resume <agent> | /team show [agent]"


async def handle_team(context: SlashCommandContext, args: list[str]) -> str | SlashCommandResult:
    if not args:
        return f"Usage: {USAGE}"
    action = args[0].lower()
    if action == "create":
        if len(args) > 2:
            return f"Usage: {USAGE}"
        return await _team_create(context, args[1] if len(args) == 2 else None)

    team_context, store = _team_context(context)
    coordinator = OrganizationCoordinator(store, agent_ids=(member.agent_id for member in team_context.members))
    if action == "list":
        if len(args) != 1:
            return f"Usage: {USAGE}"
        return _team_list(team_context, store)
    if action == "send":
        if len(args) < 3:
            return f"Usage: {USAGE}"
        return await _team_send(coordinator, store, args[1], " ".join(args[2:]))
    if action == "pause":
        if len(args) != 2:
            return f"Usage: {USAGE}"
        return _team_status(coordinator, team_context, args[1], "paused")
    if action == "resume":
        if len(args) != 2:
            return f"Usage: {USAGE}"
        return _team_status(coordinator, team_context, args[1], "idle")
    if action == "show":
        if len(args) > 2:
            return f"Usage: {USAGE}"
        return _team_show(team_context, coordinator, store, args[1] if len(args) == 2 else None)
    return f"Usage: {USAGE}"


async def _team_create(context: SlashCommandContext, project_id: str | None) -> SlashCommandResult:
    create_team = getattr(context.session, "create_team_project", None)
    if not callable(create_team):
        return SlashCommandResult("Team project creation is not supported by this session store.")
    created = await create_team(project_id=project_id)
    text = (
        f"Team project created: {created['project_id']}\n"
        f"Default agent: {created['default_agent']}\n"
        f"Workspace: {created['workspace_root']}"
    )
    return SlashCommandResult(
        text,
        display={
            "type": "team_create",
            "project_id": created["project_id"],
            "default_agent": created["default_agent"],
            "workspace_root": created["workspace_root"],
        },
    )


def _team_context(context: SlashCommandContext):
    team_context = getattr(context.runtime, "team_context", None)
    store = getattr(context.runtime, "team_store", None)
    if team_context is None or store is None:
        raise ValueError("Team commands require a registered Team Agent runtime.")
    if team_context.get_member(team_context.current_agent_id) is None:
        raise ValueError(f"Team commands require a registered Team Agent: {team_context.current_agent_id}")
    return team_context, store


def _team_list(team_context, store) -> SlashCommandResult:
    agents = [_agent_display(team_context, store, member.agent_id) for member in team_context.members]
    lines = ["Team agents:"]
    lines.extend(
        f"- {agent['id']} | {agent['display_name']} | {agent['status']}"
        for agent in agents
    )
    return SlashCommandResult(
        "\n".join(lines),
        display={"type": "team", "agents": agents},
    )


async def _team_send(
    coordinator: OrganizationCoordinator,
    store,
    recipient_id: str,
    body: str,
) -> SlashCommandResult:
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


def _team_status(coordinator: OrganizationCoordinator, team_context, agent_id: str, status: str) -> SlashCommandResult:
    state = coordinator.set_agent_status(agent_id, status)
    verb = "Paused" if status == "paused" else "Resumed"
    return SlashCommandResult(
        f"{verb} agent {agent_id}.",
        display={"type": "team_agent", "agent": _agent_display(team_context, coordinator.store, agent_id, state=state)},
    )


def _team_show(team_context, coordinator: OrganizationCoordinator, store, agent_id: str | None) -> SlashCommandResult:
    if agent_id:
        coordinator.require_agent(agent_id)
        messages = store.list_messages(agent_id=agent_id, limit=8)
        agent = _agent_display(team_context, store, agent_id)
        lines = [
            f"Agent {agent['id']}: {agent['display_name']}",
            f"Status: {agent['status']}",
            f"Workspace: {agent['workspace_root']}",
            "Recent messages:",
        ]
        lines.extend(_message_lines(messages))
        return SlashCommandResult(
            "\n".join(lines),
            display={
                "type": "team_agent_detail",
                "agent": agent,
                "messages": [message.to_dict() for message in messages],
            },
        )
    messages = store.list_messages(limit=8)
    deliveries = store.list_deliveries()
    lines = ["Recent team messages:"]
    lines.extend(_message_lines(messages))
    lines.append("Pending deliveries:")
    lines.extend(_delivery_lines(deliveries))
    return SlashCommandResult(
        "\n".join(lines),
        display={
            "type": "team_recent",
            "messages": [message.to_dict() for message in messages],
            "deliveries": [delivery.to_dict() for delivery in deliveries],
        },
    )


def _message_lines(messages) -> list[str]:
    if not messages:
        return ["- none"]
    return [
        f"- {message.id} | {message.sender_id} -> {message.recipient_id} | {message.body[:80]}"
        for message in messages
    ]


def _delivery_lines(deliveries) -> list[str]:
    if not deliveries:
        return ["- none"]
    return [f"- {delivery.message_id} -> {delivery.recipient_id} | {delivery.status}" for delivery in deliveries]


def _agent_display(team_context, store, agent_id: str, *, state=None) -> dict:
    member = team_context.get_member(agent_id)
    if member is None:
        raise ValueError(f"Agent is not a Team member: {agent_id}")
    current = state or store.get_agent_state(agent_id)
    return {
        "id": agent_id,
        "display_name": member.display_name,
        "workspace_root": member.workspace_root,
        "status": current.status,
    }


COMMAND = SlashCommandInfo(
    name="team",
    description="Operate organization agents",
    usage=USAGE,
    handler=handle_team,
)
