import { useReducer, useRef, useState } from "react";
import { initialRuntimeUrl } from "../runtimeClient.js";
import { consumePairingCode, hasStoredCredential, storeToken } from "../ticket.js";
import { currentNotificationPermission } from "../lib/notifications.js";
import { initialConnectionState, reduceConnection } from "../state/connection.js";
import { emptyConversationState, reduceConversation } from "../state/conversationReducer.js";
import { SESSION_PAGE } from "./constants.js";

// All App state plus the refs the async actions read. Refs mirror the latest
// committed value so a long-running request can tell whether the world moved
// on (session switched, connection restarted) before it applies its result.
export function useAppState() {
  const [endpoint] = useState(() => {
    const address = typeof initialRuntimeUrl === "function" ? initialRuntimeUrl() : initialRuntimeUrl;
    const code = consumePairingCode();
    if (code) storeToken(code, address);
    return address;
  });
  const [connection, dispatchConnection] = useReducer(reduceConnection, undefined, () => initialConnectionState({ authenticated: hasStoredCredential(endpoint) }));
  const [conversation, dispatchConversation] = useReducer(reduceConversation, undefined, emptyConversationState);
  const [authBusy, setAuthBusy] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [info, setInfo] = useState({});
  const [sessions, setSessions] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const [input, setInput] = useState("");
  const [stats, setStats] = useState({});
  const [goal, setGoal] = useState(null);
  const [currentModel, setCurrentModel] = useState("");
  const [currentProvider, setCurrentProvider] = useState("");
  const [providerNames, setProviderNames] = useState({});
  const [compactingSession, setCompacting] = useState("");
  const [busySession, setBusySession] = useState(false);
  const [unreadIds, setUnreadIds] = useState(() => new Set());
  const [runningIds, setRunningIds] = useState(() => new Set());
  const [notificationPermission, setNotificationPermission] = useState(() => currentNotificationPermission());
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [contextInfo, setContextInfo] = useState({ lastTurnDurationMs: 0, messageCount: 0 });
  const [contextSnapshot, setContextSnapshot] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refs = {
    drafts: useRef({}),
    input: useRef(input),
    sessionLoad: useRef(0),
    connectionRun: useRef(0),
    listRequest: useRef(0),
    startupWorkspace: useRef(""),
    switching: useRef(false),
    loadingEvents: useRef([]),
    composer: useRef(null),
    conversation: useRef(null),
    workspace: useRef(""),
    info: useRef({}),
    currentModel: useRef(""),
    currentProvider: useRef(""),
    conv: useRef(conversation),
    client: useRef(null),
    interruptTimer: useRef(null),
    paletteOpen: useRef(paletteOpen),
    sessions: useRef(sessions),
    subscribed: useRef(new Set()),
    promptStarts: useRef(new Map()),
    compactions: useRef(new Map()),
    contextRequest: useRef(0),
  };
  refs.input.current = input;
  refs.workspace.current = selectedWorkspace;
  refs.info.current = info;
  refs.currentModel.current = currentModel;
  refs.currentProvider.current = currentProvider;
  refs.conv.current = conversation;
  refs.paletteOpen.current = paletteOpen;
  refs.sessions.current = sessions;

  return {
    endpoint,
    connection, dispatchConnection,
    conversation, dispatchConversation,
    authBusy, setAuthBusy,
    loginToken, setLoginToken,
    info, setInfo,
    sessions, setSessions,
    workspaces, setWorkspaces,
    selectedWorkspace, setSelectedWorkspace,
    workspaceDraft, setWorkspaceDraft,
    workspaceBusy, setWorkspaceBusy,
    workspaceMessage, setWorkspaceMessage,
    input, setInput,
    stats, setStats,
    goal, setGoal,
    currentModel, setCurrentModel,
    currentProvider, setCurrentProvider,
    providerNames, setProviderNames,
    compacting: Boolean(compactingSession && compactingSession === info.session_id), setCompacting,
    busySession, setBusySession,
    unreadIds, setUnreadIds,
    runningIds, setRunningIds,
    notificationPermission, setNotificationPermission,
    interruptArmed, setInterruptArmed,
    paletteOpen, setPaletteOpen,
    sessionLimit, setSessionLimit,
    hasMoreSessions, setHasMoreSessions,
    contextInfo, setContextInfo,
    contextSnapshot, setContextSnapshot,
    settingsOpen, setSettingsOpen,
    refs,
  };
}
