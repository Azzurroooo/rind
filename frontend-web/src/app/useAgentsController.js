import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { methods } from "../methods.js";
import {
  activeBackgroundCount,
  buildBackgroundModel,
  buildInboxItems,
  buildInboxSections,
  buildTeamSummary,
  emptyAgentsSnapshot,
  groupTeamTasks,
  inboxBadgeCount,
  mergeManagerSessions,
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
  const [teamHistories, setTeamHistories] = useState({});
  const [managerHistory, setManagerHistory] = useState([]);
  const [archiveList, setArchiveList] = useState([]);
  // Active center-stage surface:
  // { kind: "chat" }
  // | { kind: "inbox" }
  // | { kind: "manager" }
  // | { kind: "background" }
  // | { kind: "archive" }
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

  const teamsRef = useRef(snapshot.teams);
  teamsRef.current = snapshot.teams;

  const acceptPayload = useCallback((payload) => {
    if (!mountedRef.current || !payload || typeof payload !== "object") return;
    if (payload.snapshot) {
      const normalized = normalizeAgentsSnapshot(payload.snapshot);
      setSnapshot((prev) => (JSON.stringify(prev) === JSON.stringify(normalized) ? prev : normalized));
    } else if (Array.isArray(payload.teams)) {
      const normalized = normalizeAgentsSnapshot(payload);
      setSnapshot((prev) => (JSON.stringify(prev) === JSON.stringify(normalized) ? prev : normalized));
    }
    if (typeof payload.connection === "string") {
      setConnection((prev) => (prev === payload.connection ? prev : payload.connection));
    }
    if ("service" in payload) {
      const nextService = payload.service || null;
      setService((prev) => (JSON.stringify(prev) === JSON.stringify(nextService) ? prev : nextService));
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

  const refreshAgentHistories = useCallback(
    async (targetTeamIds = null) => {
      if (connection !== "connected") return;
      const teamIds = Array.isArray(targetTeamIds)
        ? targetTeamIds
        : (teamsRef.current || []).map((t) => String(t.id));
      try {
        const [mgrRes, ...teamResults] = await Promise.all([
          requestAgent("listSessions", { manager: true }).catch(() => ({ sessions: [] })),
          ...teamIds.map((teamId) =>
            requestAgent("listSessions", { teamId })
              .then((res) => ({ teamId, sessions: Array.isArray(res?.sessions) ? res.sessions : [] }))
              .catch(() => ({ teamId, sessions: [] })),
          ),
        ]);
        if (!mountedRef.current) return;
        if (Array.isArray(mgrRes?.sessions)) {
          setManagerHistory((prev) =>
            JSON.stringify(prev) === JSON.stringify(mgrRes.sessions) ? prev : mgrRes.sessions,
          );
        }
        if (teamResults.length > 0) {
          setTeamHistories((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const item of teamResults) {
              if (JSON.stringify(next[item.teamId] || []) !== JSON.stringify(item.sessions)) {
                next[item.teamId] = item.sessions;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } catch {
        // Session history refresh is advisory.
      }
    },
    [connection, requestAgent],
  );

  // Refresh saved session histories whenever teams or snapshot sequence changes
  const teamIdsKey = snapshot.teams.map((t) => t.id).join(",");
  useEffect(() => {
    if (connection !== "connected") return;
    void refreshAgentHistories();
  }, [connection, snapshot.seq, teamIdsKey, refreshAgentHistories]);

  const openChatSurface = useCallback(() => {
    setSurface({ kind: "chat" });
  }, []);

  const openInbox = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "inbox" });
  }, [ctx.layout]);

  const openManagerView = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "manager" });
    void refreshAgentHistories([]);
  }, [ctx.layout, refreshAgentHistories]);

  const openBackground = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "background" });
    void requestAgent("serviceInfo", {}).catch(() => {});
  }, [ctx.layout, requestAgent]);

  const openArchive = useCallback(() => {
    ctx.layout.closeDrawersSilently?.();
    setSurface({ kind: "archive" });
    void requestAgent("listArchive", {})
      .then((res) => {
        if (mountedRef.current && Array.isArray(res?.teams)) {
          setArchiveList(res.teams);
        }
      })
      .catch(() => {});
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
      void refreshAgentHistories([String(teamId)]);
    },
    [ctx.layout, refreshAgentHistories],
  );

  const selectTask = useCallback((teamId, taskId) => {
    setSurface((current) => {
      const resolvedTeamId = String(teamId || (current.kind === "team" ? current.teamId : ""));
      const nextTaskId = taskId ? String(taskId) : "";
      const toggledTaskId =
        current.kind === "team" &&
        current.teamId === resolvedTeamId &&
        nextTaskId &&
        current.selectedTaskId === nextTaskId
          ? ""
          : nextTaskId;
      return {
        kind: "team",
        teamId: resolvedTeamId,
        tab: "tasks",
        selectedTaskId: toggledTaskId,
      };
    });
  }, []);

  const openAgentConversation = useCallback(
    async ({
      manager = false,
      teamId = "",
      agentId = "",
      runtimeSessionId = "",
      resumeLatest = false,
      forceNew = false,
    } = {}) => {
      ctx.layout.closeDrawersSilently?.();
      setBusy(true);
      try {
        const client = ctx.refs.client.current;
        const effectiveRuntimeId = forceNew ? "" : runtimeSessionId;
        const effectiveResumeLatest = !forceNew && !effectiveRuntimeId && resumeLatest;

        const applyAgentWorkspace = (ws) => {
          const resolvedWs = String(ws || "").trim();
          if (!resolvedWs) return;
          ctx.setSelectedWorkspace(resolvedWs);
          ctx.setWorkspaceDraft(resolvedWs);
          ctx.setInfo((curr) => ({ ...curr, workspace_root: resolvedWs }));
          if (ctx.refs.info.current) {
            ctx.refs.info.current = { ...ctx.refs.info.current, workspace_root: resolvedWs };
          }
        };

        if (ctx.refs.info.current?.methods?.includes?.(methods.agentsOpenSession) && client) {
          const opened = await client.request(methods.agentsOpenSession, {
            ...(manager ? { manager: true } : {}),
            ...(teamId ? { teamId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(effectiveRuntimeId ? { runtimeSessionId: effectiveRuntimeId } : {}),
            ...(effectiveResumeLatest ? { resumeLatest: true } : {}),
          });
          const resolvedWs = String(opened?.workspaceRoot || "");
          let targetSessionId = String(opened?.runtimeSessionId || opened?.session?.session_id || "");
          if (!targetSessionId && ctx.refs.info.current?.methods?.includes?.(methods.agentsCreateSession)) {
            const created = await client.request(methods.agentsCreateSession, {
              managementSessionId: opened?.managementSessionId,
              manager,
              teamId,
              agentId,
              workspace_root: resolvedWs,
            });
            targetSessionId = String(created?.session_id || created?.runtimeSessionId || "");
          }
          setSurface({ kind: "chat" });
          setActiveAgentOverride(
            manager
              ? { kind: "manager", agentName: "Manager", roleLabel: "Organization Coordinator", workspaceRoot: resolvedWs }
              : { kind: "member", teamId, agentId, workspaceRoot: resolvedWs },
          );
          applyAgentWorkspace(resolvedWs);
          if (targetSessionId) {
            await ctx.call.current.loadSession(targetSessionId, true);
            applyAgentWorkspace(resolvedWs);
            await ctx.call.current.refreshSessions(resolvedWs);
          }
          void refreshAgentHistories(teamId ? [teamId] : []);
          return;
        }

        // HTTP fallback via Vite bridge:
        const opened = await requestAgent("openSession", {
          ...(manager ? { manager: true } : {}),
          ...(teamId ? { teamId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(effectiveRuntimeId ? { runtimeSessionId: effectiveRuntimeId } : {}),
          ...(effectiveResumeLatest ? { resumeLatest: true } : {}),
        });
        const resolvedWs = String(opened?.workspaceRoot || "");
        setSurface({ kind: "chat" });
        setActiveAgentOverride(
          manager
            ? { kind: "manager", agentName: "Manager", roleLabel: "Organization Coordinator", workspaceRoot: resolvedWs }
            : { kind: "member", teamId, agentId, workspaceRoot: resolvedWs },
        );
        applyAgentWorkspace(resolvedWs);
        const externalTools = opened?.externalTools || null;
        if (opened?.runtimeSessionId) {
          await ctx.call.current.loadSession(opened.runtimeSessionId, true, false, { externalTools });
          applyAgentWorkspace(resolvedWs);
          await ctx.call.current.refreshSessions(resolvedWs);
        } else if (resolvedWs && client) {
          const created = await client.request(methods.sessionNew, {
            workspace_root: resolvedWs,
            ...(externalTools ? { external_tools: externalTools } : {}),
          });
          if (created?.session_id) {
            if (opened.managementSessionId) {
              await requestAgent("bindSession", {
                sessionId: opened.managementSessionId,
                runtimeSessionId: created.session_id,
              }).catch(() => {});
            }
            await ctx.call.current.loadSession(created.session_id, true, false, { externalTools });
            applyAgentWorkspace(resolvedWs);
            await ctx.call.current.refreshSessions(resolvedWs);
          }
        }
        void refreshAgentHistories(teamId ? [teamId] : []);
      } catch (error) {
        ctx.toast?.show(`Could not open conversation: ${errorText(error)}`, { tone: "error" });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx, requestAgent, refreshAgentHistories],
  );

  const renameAgentConversation = useCallback(
    async (runtimeSessionId, name, { teamId = "" } = {}) => {
      const sid = String(runtimeSessionId || "").trim();
      if (!sid) return;
      const client = ctx.refs.client.current;
      if (!client) return;
      setBusy(true);
      try {
        const input = String(name || "").trim() ? `/rename ${String(name).trim()}` : "/rename --reset";
        await client.request(methods.commandExecute, { session_id: sid, input });
        await refreshAgentHistories(teamId ? [teamId] : []);
        await ctx.call.current.refreshSessions();
        ctx.toast?.show("Renamed conversation");
      } catch (error) {
        ctx.toast?.show(`Could not rename conversation: ${errorText(error)}`, { tone: "error" });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx, refreshAgentHistories],
  );

  const deleteAgentConversation = useCallback(
    async (runtimeSessionId, { teamId = "" } = {}) => {
      const sid = String(runtimeSessionId || "").trim();
      if (!sid) return;
      setBusy(true);
      try {
        const client = ctx.refs.client.current;
        if (!wsSupported && client) {
          await client.request(methods.sessionDelete, { session_id: sid });
          await requestAgent("forgetSession", { runtimeSessionId: sid }).catch(() => {});
        } else {
          await requestAgent("deleteSession", { runtimeSessionId: sid });
        }
        await refreshAgentHistories(teamId ? [teamId] : []);
        await ctx.call.current.refreshSessions();
        ctx.toast?.show("Deleted conversation");
      } catch (error) {
        ctx.toast?.show(`Could not delete conversation: ${errorText(error)}`, { tone: "error" });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx, requestAgent, refreshAgentHistories, wsSupported],
  );

  const runAction = useCallback(
    async (method, params = {}, successToast = "") => {
      setBusy(true);
      try {
        const result = await requestAgent(method, params);
        if (successToast) ctx.toast?.show(successToast);
        if (params?.teamId) {
          void refreshAgentHistories([String(params.teamId)]);
        }
        return result;
      } catch (error) {
        ctx.toast?.show(errorText(error), { tone: "error" });
        throw error;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [ctx.toast, requestAgent, refreshAgentHistories],
  );

  const activeSessionContext = useMemo(() => {
    if (activeAgentOverride?.kind === "manager") {
      const mgrAgent = snapshot.agents.find((a) => String(a.name).toLowerCase() === "manager");
      return {
        ...activeAgentOverride,
        workspaceRoot: String(
          activeAgentOverride.workspaceRoot ||
            mgrAgent?.canonicalWorkspace ||
            ctx.selectedWorkspace ||
            ctx.info?.workspace_root ||
            "",
        ),
      };
    }
    if (activeAgentOverride?.kind === "member" && activeAgentOverride.teamId) {
      const team = snapshot.teams.find((t) => t.id === activeAgentOverride.teamId);
      const agent = snapshot.agents.find((a) => a.id === activeAgentOverride.agentId);
      const membership = snapshot.memberships.find(
        (m) => m.teamId === activeAgentOverride.teamId && m.agentId === activeAgentOverride.agentId,
      );
      if (team && agent) {
        return {
          kind: "member",
          workspaceRoot: String(
            activeAgentOverride.workspaceRoot ||
              agent.canonicalWorkspace ||
              ctx.selectedWorkspace ||
              ctx.info?.workspace_root ||
              "",
          ),
          teamId: String(team.id),
          teamName: String(team.name || team.id),
          agentId: String(agent.id),
          agentName: String(agent.name || agent.id),
          roleLabel: String(
            membership?.position || (team.leaderAgentId === agent.id ? "Team Leader" : "Specialist"),
          ),
          isLeader: team.leaderAgentId === agent.id,
          status: String(membership?.status || "Idle"),
        };
      }
    }
    return resolveSessionAgentContext(
      snapshot,
      ctx.info?.session_id,
      ctx.info?.workspace_root || ctx.selectedWorkspace,
    );
  }, [snapshot, ctx.info?.session_id, ctx.info?.workspace_root, ctx.selectedWorkspace, activeAgentOverride]);

  const teamSummaries = useMemo(
    () =>
      snapshot.teams
        .map((team) => buildTeamSummary(snapshot, team.id, teamHistories[team.id] || []))
        .filter(Boolean),
    [snapshot, teamHistories],
  );

  const managerSummary = useMemo(
    () => mergeManagerSessions(snapshot, managerHistory),
    [snapshot, managerHistory],
  );

  const currentTeamId =
    surface.kind === "team"
      ? surface.teamId
      : activeSessionContext.kind === "member"
        ? activeSessionContext.teamId
        : snapshot.teams[0]?.id || "";

  const currentTeamSummary = useMemo(
    () => teamSummaries.find((item) => item.team.id === currentTeamId) || null,
    [teamSummaries, currentTeamId],
  );

  const currentTeamTasks = useMemo(
    () =>
      currentTeamId
        ? groupTeamTasks(snapshot, currentTeamId)
        : {
            all: [],
            groups: { needs: [], working: [], queued: [], delegated: [], done: [], cancelled: [] },
            sections: [],
            columns: { queued: [], in_progress: [], needs_attention: [], completed: [] },
          },
    [snapshot, currentTeamId],
  );

  const inboxSections = useMemo(() => buildInboxSections(snapshot), [snapshot]);
  const inboxItems = useMemo(() => buildInboxItems(snapshot), [snapshot]);
  const inboxCount = useMemo(() => inboxBadgeCount(snapshot), [snapshot]);
  const backgroundModel = useMemo(() => buildBackgroundModel(snapshot, service), [snapshot, service]);
  const bgCount = useMemo(() => activeBackgroundCount(snapshot), [snapshot]);

  return {
    snapshot,
    connection,
    service,
    busy,
    surface,
    setSurface,
    activeSessionContext,
    teamSummaries,
    managerSummary,
    archiveList: archiveList.length > 0 ? archiveList : snapshot.archivedTeams || [],
    currentTeamId,
    currentTeamSummary,
    currentTeamTasks,
    inboxSections,
    inboxItems,
    inboxCount,
    backgroundModel,
    bgCount,
    acceptPayload,
    openChatSurface,
    openInbox,
    openManagerView,
    openBackground,
    openArchive,
    openTeam,
    selectTask,
    openAgentConversation,
    renameAgentConversation,
    deleteAgentConversation,
    refreshAgentHistories,
    clearAgentOverride: () => setActiveAgentOverride(null),
    requestAgent,
    runAction,
  };
}
