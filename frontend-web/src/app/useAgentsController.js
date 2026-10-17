import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { methods } from "../methods.js";
import {
  activeBackgroundCount,
  buildInboxItems,
  buildTeamSummary,
  emptyAgentsSnapshot,
  groupTeamTasks,
  inboxBadgeCount,
  normalizeAgentsSnapshot,
  resolveSessionAgentContext,
} from "../lib/agentsModel.js";
import { errorText } from "./constants.js";

// Native Team Agents Management controller for Rind Web.
// Transparently uses the Desktop Gateway WebSocket RPC (`rind/agents/*`) when
// advertised, or the Vite dev bridge (`/api/agents` + `/api/agents/stream`)
// when running against a standalone Python runtime in a browser.
export function useAgentsController(ctx) {
  const [snapshot, setSnapshot] = useState(emptyAgentsSnapshot);
  const [connection, setConnection] = useState("connecting");
  const [service, setService] = useState(null);
  const [busy, setBusy] = useState(false);
  // Active center-stage surface:
  // { kind: "chat" }
  // | { kind: "inbox" }
  // | { kind: "background" }
  // | { kind: "team", teamId: string, tab: "organization" | "tasks", selectedTaskId?: string }
  const [surface, setSurface] = useState({ kind: "chat" });
  const [activeAgentOverride, setActiveAgentOverride] = useState(null);
  const wsSupported = Boolean(ctx.info?.methods?.includes?.(methods.agentsGet));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acceptPayload = useCallback((payload) => {
    if (!mountedRef.current || !payload || typeof payload !== "object") return;
    if (payload.snapshot) {
      setSnapshot(normalizeAgentsSnapshot(payload.snapshot));
    } else if (Array.isArray(payload.teams)) {
      setSnapshot(normalizeAgentsSnapshot(payload));
    }
    if (typeof payload.connection === "string") {
      setConnection(payload.connection);
    }
    if ("service" in payload) {
      setService(payload.service || null);
    }
  }, []);

  const requestAgent = useCallback(
    async (method, params = {}) => {
      if (ctx.refs.info.current?.methods?.includes?.(methods.agentsRequest)) {
        const client = ctx.refs.client.current;
        if (!client) throw new Error("Runtime client not connected.");
        if (method === "getState") {
          const state = await client.request(methods.agentsGet, {});
          acceptPayload(state);
          return state;
        }
        const res = await client.request(methods.agentsRequest, { method, params });
        const fresh = await client.request(methods.agentsGet, {}).catch(() => null);
        if (fresh) acceptPayload(fresh);
        return res;
      }
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.error) {
        throw new Error(data?.error?.message || data?.error || `Request failed (${response.status})`);
      }
      if (method === "getState" || method === "reconnect" || method === "restartService") {
        acceptPayload(data.result);
      }
      return data.result;
    },
    [acceptPayload, ctx.refs.client, ctx.refs.info],
  );

  // Sync initial state when WebSocket advertises rind/agents/get
  useEffect(() => {
    if (!wsSupported) return undefined;
    const client = ctx.refs.client.current;
    if (!client) return undefined;
    void client
      .request(methods.agentsGet, {})
      .then((res) => acceptPayload(res))
      .catch(() => {});
    return undefined;
  }, [wsSupported, ctx.info?.session_id, acceptPayload, ctx.refs.client]);

  // Connect to /api/agents/stream SSE when running in browser dev server mode
  useEffect(() => {
    if (wsSupported) return undefined;
    if (typeof window === "undefined" || typeof window.EventSource !== "function") {
      return undefined;
    }
    let es = null;
    try {
      es = new window.EventSource("/api/agents/stream");
      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          acceptPayload(parsed);
        } catch {
          // Ignore malformed SSE frames.
        }
      };
      es.onerror = () => {
        if (mountedRef.current) setConnection("offline");
      };
    } catch {
      // Ignore if SSE is unavailable.
    }
    return () => {
      es?.close?.();
    };
  }, [wsSupported, acceptPayload]);

  const openChatSurface = useCallback(() => {
    setSurface({ kind: "chat" });
  }, []);

  const openInbox = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "inbox" });
  }, [ctx.layout]);

  const openBackground = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "background" });
    void requestAgent("serviceInfo", {}).catch(() => {});
  }, [ctx.layout, requestAgent]);

  const openTeam = useCallback(
    (teamId, tab = "organization", selectedTaskId = "") => {
      if (!teamId) return;
      ctx.layout.closeDrawersSilently?.();
      setSurface({
        kind: "team",
        teamId: String(teamId),
        tab: tab === "tasks" ? "tasks" : "organization",
        selectedTaskId: selectedTaskId ? String(selectedTaskId) : "",
      });
    },
    [ctx.layout],
  );

  const selectTask = useCallback((teamId, taskId) => {
    setSurface((current) => ({
      kind: "team",
      teamId: String(teamId || (current.kind === "team" ? current.teamId : "")),
      tab: "tasks",
      selectedTaskId: taskId ? String(taskId) : "",
    }));
  }, []);

  const openAgentConversation = useCallback(
    async ({ manager = false, teamId = "", agentId = "", runtimeSessionId = "" } = {}) => {
      ctx.layout.closeDrawersSilently?.();
      setBusy(true);
      try {
        const client = ctx.refs.client.current;
        if (ctx.refs.info.current?.methods?.includes?.(methods.agentsOpenSession) && client) {
          const opened = await client.request(methods.agentsOpenSession, {
            ...(manager ? { manager: true } : {}),
            ...(teamId ? { teamId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(runtimeSessionId ? { runtimeSessionId } : {}),
          });
          let targetSessionId = String(opened?.runtimeSessionId || opened?.session?.session_id || "");
          if (!targetSessionId && ctx.refs.info.current?.methods?.includes?.(methods.agentsCreateSession)) {
            const created = await client.request(methods.agentsCreateSession, {
              managementSessionId: opened?.managementSessionId,
              manager,
              teamId,
              agentId,
              workspace_root: opened?.workspaceRoot,
            });
            targetSessionId = String(created?.session_id || created?.runtimeSessionId || "");
          }
          setSurface({ kind: "chat" });
          setActiveAgentOverride(
            manager
              ? { kind: "manager", agentName: "Manager", roleLabel: "Organization Coordinator" }
              : { kind: "member", teamId, agentId },
          );
          if (opened?.workspaceRoot) {
            ctx.setSelectedWorkspace(opened.workspaceRoot);
            ctx.setWorkspaceDraft(opened.workspaceRoot);
          }
          if (targetSessionId) {
            await ctx.call.current.loadSession(targetSessionId, true);
            await ctx.call.current.refreshSessions(opened?.workspaceRoot);
          }
          return;
        }

        // HTTP fallback via Vite bridge:
        const opened = await requestAgent("openSession", {
          ...(manager ? { manager: true } : {}),
          ...(teamId ? { teamId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(runtimeSessionId ? { runtimeSessionId } : {}),
        });
        setSurface({ kind: "chat" });
        setActiveAgentOverride(
          manager
            ? { kind: "manager", agentName: "Manager", roleLabel: "Organization Coordinator" }
            : { kind: "member", teamId, agentId },
        );
        if (opened?.runtimeSessionId) {
          await ctx.call.current.loadSession(opened.runtimeSessionId, true);
        } else if (opened?.workspaceRoot) {
          await ctx.call.current.selectWorkspace(opened.workspaceRoot);
          if (!ctx.refs.info.current?.session_id && client) {
            const created = await client.request(methods.sessionNew, { workspace_root: opened.workspaceRoot });
            if (created?.session_id) {
              if (opened.managementSessionId) {
                await requestAgent("bindSession", {
                  sessionId: opened.managementSessionId,
                  runtimeSessionId: created.session_id,
                }).catch(() => {});
              }
              await ctx.call.current.loadSession(created.session_id, true);
              await ctx.call.current.refreshSessions(opened.workspaceRoot);
            }
          }
        }
      } catch (error) {
        ctx.toast?.show(`Could not open agent chat: ${errorText(error)}`, { tone: "error" });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx, requestAgent],
  );

  const runAction = useCallback(
    async (method, params = {}, successToast = "") => {
      setBusy(true);
      try {
        const result = await requestAgent(method, params);
        if (successToast) ctx.toast?.show(successToast);
        return result;
      } catch (error) {
        ctx.toast?.show(errorText(error), { tone: "error" });
        throw error;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx.toast, requestAgent],
  );

  const activeSessionContext = useMemo(() => {
    const resolved = resolveSessionAgentContext(
      snapshot,
      ctx.info?.session_id,
      ctx.info?.workspace_root || ctx.selectedWorkspace,
    );
    if (resolved.kind !== "independent") return resolved;
    if (activeAgentOverride?.kind === "manager") return activeAgentOverride;
    if (activeAgentOverride?.kind === "member" && activeAgentOverride.teamId) {
      const team = snapshot.teams.find((t) => t.id === activeAgentOverride.teamId);
      const agent = snapshot.agents.find((a) => a.id === activeAgentOverride.agentId);
      const membership = snapshot.memberships.find(
        (m) => m.teamId === activeAgentOverride.teamId && m.agentId === activeAgentOverride.agentId,
      );
      if (team && agent) {
        return {
          kind: "member",
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(agent.id),
          agentName: String(agent.name || agent.id),
          roleLabel: String(membership?.position || (team.leaderAgentId === agent.id ? "Team Leader" : "Specialist")),
          isLeader: team.leaderAgentId === agent.id,
          status: String(membership?.status || "Idle"),
        };
      }
    }
    return resolved;
  }, [snapshot, ctx.info?.session_id, ctx.info?.workspace_root, ctx.selectedWorkspace, activeAgentOverride]);

  const currentTeamId =
    surface.kind === "team"
      ? surface.teamId
      : activeSessionContext.kind === "member"
        ? activeSessionContext.teamId
        : snapshot.teams[0]?.id || "";

  const currentTeamSummary = useMemo(
    () => (currentTeamId ? buildTeamSummary(snapshot, currentTeamId) : null),
    [snapshot, currentTeamId],
  );

  const currentTeamTasks = useMemo(
    () => (currentTeamId ? groupTeamTasks(snapshot, currentTeamId) : { all: [], columns: { queued: [], in_progress: [], needs_attention: [], completed: [] } }),
    [snapshot, currentTeamId],
  );

  const inboxItems = useMemo(() => buildInboxItems(snapshot), [snapshot]);
  const inboxCount = useMemo(() => inboxBadgeCount(snapshot), [snapshot]);
  const bgCount = useMemo(() => activeBackgroundCount(snapshot), [snapshot]);

  return {
    snapshot,
    connection,
    service,
    busy,
    surface,
    setSurface,
    activeSessionContext,
    currentTeamId,
    currentTeamSummary,
    currentTeamTasks,
    inboxItems,
    inboxCount,
    bgCount,
    acceptPayload,
    openChatSurface,
    openInbox,
    openBackground,
    openTeam,
    selectTask,
    openAgentConversation,
    clearAgentOverride: () => setActiveAgentOverride(null),
    requestAgent,
    runAction,
  };
}
