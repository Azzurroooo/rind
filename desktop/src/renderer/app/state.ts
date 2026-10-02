import { mergeSlashCatalog } from "../desktop-slash.ts"
import { INSPECTOR_WIDTH } from "../inspector-model.ts"
import { type ModelOption } from "../composer-select.ts"
import { createTaskMonitorState } from "../task-monitor.ts"
import { createConversation } from "../timeline-model.ts"
import { type AppState, type InspectorLoad } from "./types.ts"

export function emptyLoad<T>(): InspectorLoad<T> {
  return { sessionId: "", loading: false, error: "" }
}



export const state: AppState = {
  runtime: { status: "stopped" },
  settings: { model: "", baseUrl: "", reasoningEffort: "", hasApiKey: false },
  settingsOpen: false,
  settingsSaving: false,
  settingsAutoOpened: false,
  runtimeTurnPending: {},
  activeTurnIds: {},
  pendingInputs: {},
  viewedSessionId: "",
  viewedProjectPath: "",
  chatProjectPath: "",
  conversationCache: {},
  sessionModels: {},
  sessionEfforts: {},
  model: "",
  effort: "",
  modelProvider: "",
  models: [] as ModelOption[],
  providerNames: {} as Record<string, string>,
  projects: [],
  recentSessions: [],
  recentSessionTotal: 0,
  recentLimit: 10,
  recentLoading: false,
  fallbackProjectPath: "",
  pendingRecentSessionIds: new Set(),
  sessionPages: {},
  sessionTotals: {},
  sidebarOpen: true,
  sidebarWidth: 264,
  inspectorOpen: false,
  inspectorWidth: INSPECTOR_WIDTH.fallback,
  inspectorTab: "context",
  inspectorContext: emptyLoad(),
  inspectorUsage: emptyLoad(),
  expandedProjects: new Set(),
  projectMenuPath: "",
  expandedDirectories: new Set([""]),
  fileListings: {},
  drafts: {},
  conversation: createConversation(),
  questionSelection: undefined,
  expandedTools: new Set(),
  revealedTools: new Set(),
  segmentFolds: new Map(),
  toolBodiesShown: new Set(),
  composerMenuOpen: false,
  compactingSessions: new Set(),
  slashCommandPending: false,
  slashCommandInput: "",
  slashCommands: mergeSlashCatalog([]),
  slashMenuOpen: false,
  slashMenuActiveIndex: 0,
  modelMenuOpen: false,
  modelMenuLoading: false,
  modelChanging: false,
  effortMenuOpen: false,
  effortChanging: false,
  projectMenuOpen: false,
  attachments: {},
  sessionMenuId: "",
  sessionDeleteConfirmId: "",
  sessionDeleteBusyId: "",
  sessionSearch: "",
  taskMonitor: createTaskMonitorState(),
  goal: { busy: false },
  theme: "system",
  notificationsEnabled: true,
  paletteOpen: false,
  paletteQuery: "",
  paletteActiveIndex: 0,
  shortcutsOpen: false,
  lastPrompts: {},
  notice: "",
}
export const toolOpenRequests = new Map<string, number>()
export const replayRequests = new Map<string, Promise<void>>()
export const uploadPromises = new Map<string, Promise<void>>()
export const preparingPrompts = new Map<string, symbol>()

export function sessionCompacting(sessionId = state.viewedSessionId) {
  const conversation = sessionId === state.viewedSessionId ? state.conversation : state.conversationCache[sessionId]
  return state.compactingSessions.has(sessionId) || conversation?.operation === "compact"
}

export const chipFileBacklog = new Map<string, File>()

export const vars: {
  workingTimer: ReturnType<typeof setInterval> | undefined
  lastRenderedEntries: number
  toolPinSequence: number
  renderFrame: number | undefined
  renderTimer: ReturnType<typeof setTimeout> | undefined
  toolAnimationUntil: number
  resizeStart: { target: "sidebar" | "inspector"; pointerId: number; x: number; width: number; lastWidth: number } | undefined
  renderedProjectListStructureKey: string
  renderedRecentListStructureKey: string
  modelMenuRequestId: number
  lastRuntimeSequence: number
  runtimeEventGeneration: number
  overviewVersion: number
  recentFlushPromise: Promise<void> | undefined
  attachmentSequence: number
  sessionMenuUp: boolean
  deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined
  taskMonitorTimer: ReturnType<typeof setInterval> | undefined
  goalLoadSequence: number
} = {
  workingTimer: undefined,
  lastRenderedEntries: 0,
  toolPinSequence: 0,
  renderFrame: undefined,
  renderTimer: undefined,
  toolAnimationUntil: 0,
  resizeStart: undefined,
  renderedProjectListStructureKey: "",
  renderedRecentListStructureKey: "",
  modelMenuRequestId: 0,
  lastRuntimeSequence: 0,
  runtimeEventGeneration: 0,
  overviewVersion: 0,
  recentFlushPromise: undefined,
  attachmentSequence: 0,
  sessionMenuUp: false,
  deleteConfirmTimer: undefined,
  taskMonitorTimer: undefined,
  goalLoadSequence: 0,
}
