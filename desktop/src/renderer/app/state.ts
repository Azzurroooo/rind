import { fallbackSlashCommands } from "../slash-commands.ts"
import { createTaskMonitorState } from "../task-monitor.ts"
import { createConversation } from "../timeline-model.ts"
import { type AppState } from "./types.ts"



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
  models: [],
  projects: [],
  recentSessions: [],
  fallbackProjectPath: "",
  pendingRecentSessionIds: new Set(),
  sessionPages: {},
  sessionTotals: {},
  sidebarOpen: true,
  sidebarWidth: 264,
  filesOpen: false,
  filePanelWidth: 480,
  expandedProjects: new Set(),
  projectMenuPath: "",
  expandedDirectories: new Set([""]),
  fileListings: {},
  drafts: {},
  conversation: createConversation(),
  questionSelection: undefined,
  expandedTools: new Set(),
  revealedTools: new Set(),
  stepGroups: new Map(),
  planDock: { collapsed: false, sessionId: "", dismissedPlanErrors: new Set() },
  composerMenuOpen: false,
  compacting: false,
  slashCommandPending: false,
  slashCommandInput: "",
  slashCommands: fallbackSlashCommands,
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
  taskMonitorOpen: false,
  taskMonitor: createTaskMonitorState(),
  goal: { busy: false, setOpen: false, visible: false, draft: "" },
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
export const preparingPrompts = new Set<string>()

export const chipFileBacklog = new Map<string, File>()

export const vars: {
  workingTimer: ReturnType<typeof setInterval> | undefined
  lastRenderedEntries: number
  toolPinSequence: number
  renderFrame: number | undefined
  renderTimer: ReturnType<typeof setTimeout> | undefined
  toolAnimationUntil: number
  resizeStart: { target: "sidebar" | "files"; pointerId: number; x: number; width: number; lastWidth: number } | undefined
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
