import { type DesktopFileListing, type DesktopFilePreview, type DesktopGoal, type DesktopProject, type DesktopRecentSession, type DesktopSessionSummary, type DesktopSettings, type DesktopTheme, type RuntimeSnapshot } from "../../preload/types.ts"
import { type PendingInput, type PlanDockPresentation } from "../composer-region.ts"
import { type QuestionSelection } from "../question-state.ts"
import { type ContextDisplay } from "../context-report.ts"
import { type BackgroundOutput, type BackgroundRecord, type InspectorTab, type UsageSummary } from "../inspector-model.ts"
import { type SlashCommand } from "../slash-commands.ts"
import { type TaskMonitorState } from "../task-monitor.ts"
import { type ConversationState } from "../timeline-model.ts"



export type AttachmentChip = {
  id: string
  name: string
  size: number
  mime: string
  previewUrl: string
  status: "uploading" | "ok" | "failed"
  path: string
  error: string
}

export type GoalPanelState = {
  value?: DesktopGoal
  busy: boolean
  setOpen: boolean
  draft: string
}

/** One inspector tab's fetched data; sessionId marks which session it describes. */
export type InspectorLoad<T> = {
  sessionId: string
  loading: boolean
  error: string
  value?: T
}

export type BackgroundHistoryState = {
  records: BackgroundRecord[]
  expandedId: string
  outputs: Record<string, BackgroundOutput>
  reading: Set<string>
  loading: boolean
  error: string
}

export type AppState = {
  runtime: RuntimeSnapshot
  settings: DesktopSettings
  settingsOpen: boolean
  settingsSaving: boolean
  settingsAutoOpened: boolean
  runtimeTurnPending: Record<string, boolean>
  activeTurnIds: Record<string, string>
  pendingInputs: Record<string, PendingInput[]>
  viewedSessionId: string
  viewedProjectPath: string
  chatProjectPath: string
  conversationCache: Record<string, ConversationState>
  sessionModels: Record<string, string>
  sessionEfforts: Record<string, string>
  model: string
  effort: string
  models: string[]
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  fallbackProjectPath: string
  pendingRecentSessionIds: Set<string>
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  sidebarOpen: boolean
  sidebarWidth: number
  inspectorOpen: boolean
  inspectorWidth: number
  inspectorTab: InspectorTab
  inspectorContext: InspectorLoad<ContextDisplay>
  inspectorUsage: InspectorLoad<UsageSummary>
  backgroundHistory: BackgroundHistoryState
  expandedProjects: Set<string>
  projectMenuPath: string
  expandedDirectories: Set<string>
  fileListings: Record<string, DesktopFileListing>
  filePreview?: DesktopFilePreview
  drafts: Record<string, string>
  conversation: ConversationState
  questionSelection?: QuestionSelection
  expandedTools: Set<string>
  revealedTools: Set<string>
  /** Explicit open or closed choice per work segment; absent means automatic. */
  segmentFolds: ReadonlyMap<string, boolean>
  /** "id:all", "id:raw" and "id:details" toggles on tool bodies. */
  toolBodiesShown: ReadonlySet<string>
  planDock: PlanDockPresentation
  composerMenuOpen: boolean
  compacting: boolean
  slashCommandPending: boolean
  slashCommandInput: string
  slashCommands: SlashCommand[]
  slashMenuOpen: boolean
  slashMenuActiveIndex: number
  modelMenuOpen: boolean
  modelMenuLoading: boolean
  modelChanging: boolean
  effortMenuOpen: boolean
  effortChanging: boolean
  projectMenuOpen: boolean
  attachments: Record<string, AttachmentChip[]>
  sessionMenuId: string
  sessionDeleteConfirmId: string
  sessionDeleteBusyId: string
  sessionSearch: string
  taskMonitor: TaskMonitorState
  goal: GoalPanelState
  theme: DesktopTheme
  notificationsEnabled: boolean
  paletteOpen: boolean
  paletteQuery: string
  paletteActiveIndex: number
  shortcutsOpen: boolean
  lastPrompts: Record<string, string>
  notice: string
}
// ---------- keyboard map (C11): one table for every shortcut ----------

export type KeyBinding = {
  id: string
  matches: (event: KeyboardEvent) => boolean
  run: (event: KeyboardEvent) => void
}
