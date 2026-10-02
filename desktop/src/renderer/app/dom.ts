import brandMarkUrl from "../assets/brand-mark.svg"
import { composerRegionMarkup } from "../composer-region.ts"
import { ArrowDown, Bell, ChartNoAxesColumn, Ellipsis, Keyboard, KeyRound, ListTodo, MonitorSmartphone, PanelLeft, PanelRight, renderIcon, Search, Settings, SlidersHorizontal, SunMoon, X } from "../icons.ts"
import { INSPECTOR_TAB_LABELS, INSPECTOR_TABS } from "../inspector-model.ts"
import { remoteAccessMarkup } from "../remote-access.ts"
import { escapeHtml } from "./html.ts"



export const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")
export const appRoot: HTMLElement = root
document.body.dataset.platform = window.api.platform
export const appVersion = await window.api.version()

appRoot.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="identity">
        <div class="brand-group">
          <img class="brand-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
          <span class="brand">Rind</span>
        </div>
        <span id="connection" class="connection"><span class="status-pip"></span><span id="connection-text">Stopped</span></span>
      </div>
      <div class="topbar-actions">
        <span class="app-version" aria-label="Rind version">v${escapeHtml(appVersion)}</span>
        <button id="open-palette" type="button" class="icon-button topbar-button" data-tooltip="Command palette (Ctrl+K)" aria-label="Command palette (Ctrl+K)">${renderIcon(Search)}</button>
        <button id="open-remote" type="button" class="icon-button topbar-button" data-tooltip="Remote access" aria-label="Remote access">${renderIcon(MonitorSmartphone)}</button>
        <button id="toggle-theme" type="button" class="icon-button topbar-button" data-tooltip="Switch theme" aria-label="Switch theme">${renderIcon(SunMoon)}</button>
        <button id="toggle-sidebar" type="button" class="icon-button topbar-button" data-tooltip="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar (Ctrl+B)" aria-expanded="true">${renderIcon(PanelLeft)}</button>
        <button id="open-shortcuts" type="button" class="icon-button topbar-button" data-tooltip="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts (?)">${renderIcon(Keyboard)}</button>
        <button id="open-settings" type="button" class="icon-button topbar-button" data-tooltip="Open settings" aria-label="Open settings">${renderIcon(Settings)}</button>
      </div>
    </header>
    <main class="layout">
      <aside id="sidebar" class="sidebar" aria-label="Projects and sessions">
        <div id="sidebar-resize-handle" class="sidebar-resize-handle" role="separator" aria-label="Resize projects sidebar" aria-orientation="vertical"></div>
        <div class="sidebar-actions">
          <button id="new-session" type="button" class="primary-button" title="Start a new chat in the active project">New chat</button>
        </div>
        <div class="sidebar-body panel-scroll">
          <div class="session-search-wrap">
            ${renderIcon(Search, "session-search-icon")}
            <input id="session-search" type="search" placeholder="Search sessions" aria-label="Search loaded sessions" autocomplete="off" />
          </div>
          <section class="sidebar-projects" aria-label="Projects"><div class="sidebar-heading"><h2 class="sidebar-section-title">Projects</h2><button id="sidebar-add-project" type="button" class="ghost-button" title="Add project">Add</button></div>
          <div id="project-list" class="project-list"></div></section>
          <section id="recent-sessions" class="recent-sessions" aria-label="Recent sessions" hidden>
            <h2 class="sidebar-section-title">Recent sessions</h2>
            <div id="recent-list" class="recent-list"></div>
          </section>
        </div>
        <div class="sidebar-footer"><button id="open-usage" type="button" class="sidebar-footer-button">${renderIcon(ChartNoAxesColumn)}<span>Usage</span></button></div>
      </aside>
      <section class="conversation">
        <header class="conversation-head">
          <div class="conversation-title">
            <h1 id="session-title" class="session-title">New session</h1>
            <span id="session-status" class="session-status" role="status" hidden><span class="session-status-dot" aria-hidden="true"></span><span id="session-status-text">Idle</span></span>
          </div>
          <div class="session-actions">
            <button id="toggle-tasks" type="button" class="icon-button head-button" data-tooltip="Activity" aria-label="Activity" aria-controls="inspector" aria-expanded="false">${renderIcon(ListTodo)}<span id="task-count-badge" class="head-badge" hidden></span></button>
            <button id="toggle-inspector" type="button" class="icon-button head-button" data-tooltip="Show inspector" aria-label="Show inspector" aria-controls="inspector" aria-expanded="false">${renderIcon(PanelRight)}</button>
            <div class="session-head-menu-wrap">
              <button id="session-head-menu-trigger" type="button" class="icon-button head-button" data-tooltip="More actions" aria-label="More conversation actions" aria-haspopup="menu" aria-controls="session-head-menu" aria-expanded="false">${renderIcon(Ellipsis)}</button>
              <div id="session-head-menu" class="menu session-head-menu" role="menu" aria-label="Conversation actions" hidden>
                <button id="export-session" type="button" class="menu-item" role="menuitem" tabindex="-1">Export conversation</button>
                <button id="fork-session" type="button" class="menu-item" role="menuitem" tabindex="-1">Fork conversation</button>
              </div>
            </div>
          </div>
        </header>
        <div id="notice" class="notice" role="status" hidden><span id="notice-text"></span><button id="retry" type="button" class="ghost-button" hidden>Retry</button></div>
        <div class="stream-wrap">
          <div id="message-stream" class="message-stream" aria-live="polite"></div>
          <button id="jump-latest" type="button" class="jump-latest" data-tooltip="Jump to latest" aria-label="Jump to latest" hidden>${renderIcon(ArrowDown)}</button>
        </div>
        ${composerRegionMarkup()}
      </section>
      <aside id="inspector" class="inspector" aria-label="Inspector">
        <div id="inspector-resize-handle" class="inspector-resize-handle" role="separator" aria-label="Resize inspector" aria-orientation="vertical"></div>
        <div class="inspector-head">
          <div class="inspector-tabs" role="tablist" aria-label="Inspector sections">
            ${INSPECTOR_TABS.map((tab) => `<button id="inspector-tab-${tab}" type="button" role="tab" class="inspector-tab" data-inspector-tab="${tab}" aria-controls="inspector-panel-${tab}" aria-selected="false" tabindex="-1">${INSPECTOR_TAB_LABELS[tab]}</button>`).join("")}
          </div>
          <button id="close-inspector" type="button" class="icon-button inspector-close" data-tooltip="Close inspector" aria-label="Close inspector">${renderIcon(X)}</button>
        </div>
        <div id="inspector-scope" class="inspector-scope">Current session</div>
        <section id="inspector-panel-context" class="inspector-panel panel-scroll" role="tabpanel" aria-labelledby="inspector-tab-context" tabindex="0" hidden>
          <div class="inspector-toolbar"><span class="subtle">Current context window</span><button type="button" class="ghost-button" data-inspector-refresh="context">Refresh</button></div>
          <div id="inspector-context"></div>
        </section>
        <section id="inspector-panel-activity" class="inspector-panel panel-scroll activity-panel" role="tabpanel" aria-labelledby="inspector-tab-activity" tabindex="0" hidden>
          <div id="activity-plan" aria-label="Plan"></div>
          <section id="task-monitor" class="task-monitor" aria-label="Running background tasks"></section>
          <section id="goal-panel" class="goal-panel" aria-label="Session goal"></section>
        </section>
        <section id="inspector-panel-files" class="inspector-panel panel-scroll inspector-files" role="tabpanel" aria-labelledby="inspector-tab-files" tabindex="0" hidden>
          <p id="files-unavailable" class="inspector-empty" hidden>Choose an available project to browse its files.</p>
          <section id="file-preview" class="file-preview" hidden></section>
          <div id="file-tree" class="file-tree"></div>
        </section>
      </aside>
    </main>
    <dialog id="usage-dialog" class="settings-dialog usage-dialog" aria-labelledby="usage-title"><div class="settings-heading"><div><h2 id="usage-title">Usage</h2><p>Across all projects and sessions on this Rind computer.</p></div><button id="close-usage" type="button" class="icon-button" aria-label="Close usage">${renderIcon(X)}</button></div><div class="usage-toolbar"><span class="subtle">Last 7 days</span><button id="refresh-usage" type="button" class="ghost-button usage-refresh">Refresh</button></div><div id="inspector-usage"></div></dialog>
    ${remoteAccessMarkup()}
    <dialog id="settings-dialog" class="settings-dialog settings-shell" aria-labelledby="settings-title">
      <form id="settings-form" method="dialog" class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <h2 id="settings-title" class="settings-title">Settings</h2>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" class="settings-tabs">
        <button id="settings-tab-general" type="button" role="tab" class="settings-tab" data-settings-tab="general" aria-controls="settings-panel-general" aria-selected="true">${renderIcon(SlidersHorizontal, "settings-tab-icon")}<span>General</span></button>
        <button id="settings-tab-providers" type="button" role="tab" class="settings-tab" data-settings-tab="providers" aria-controls="settings-panel-providers" aria-selected="false" tabindex="-1">${renderIcon(KeyRound, "settings-tab-icon")}<span>Providers</span></button>
        <button id="settings-tab-preferences" type="button" role="tab" class="settings-tab" data-settings-tab="preferences" aria-controls="settings-panel-preferences" aria-selected="false" tabindex="-1">${renderIcon(Bell, "settings-tab-icon")}<span>Preferences</span></button>
        </div>
      </nav>
      <div class="settings-content">
        <button id="close-settings" type="button" class="icon-button settings-close" aria-label="Close settings" data-tooltip="Close">${renderIcon(X)}</button>
        <section id="settings-panel-general" class="settings-panel" role="tabpanel" aria-labelledby="settings-tab-general" data-settings-panel="general">
          <h3 class="settings-section-title">Model provider</h3>
          <p class="settings-section-desc">Shared ~/.rind/settings.json used when no provider sign-in is configured.</p>
          <div class="settings-row"><div class="settings-row-text"><span class="settings-row-label"><label for="settings-api-key">API key</label></span><span class="settings-row-desc"><span id="settings-key-status"></span></span></div><div class="settings-row-control"><input id="settings-api-key" type="password" autocomplete="new-password" placeholder="Leave blank to keep" /></div></div>
          <div class="settings-row"><div class="settings-row-text"><span class="settings-row-label"><label for="settings-base-url">Base URL</label></span></div><div class="settings-row-control"><input id="settings-base-url" type="url" placeholder="https://api.openai.com/v1" /></div></div>
          <div class="settings-row"><div class="settings-row-text"><span class="settings-row-label"><label for="settings-model">Model</label></span></div><div class="settings-row-control"><input id="settings-model" type="text" placeholder="Default model" /></div></div>
          <div class="settings-row"><div class="settings-row-text"><span class="settings-row-label"><label for="settings-reasoning">Reasoning effort</label></span></div><div class="settings-row-control"><select id="settings-reasoning"><option value="">Provider default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Maximum</option></select></div></div>
        </section>
        <section id="settings-panel-providers" class="settings-panel" role="tabpanel" aria-labelledby="settings-tab-providers" data-settings-panel="providers" hidden>
          <h3 class="settings-section-title">Providers</h3>
          <p class="settings-section-desc">Sign in to model providers. Keys are stored by the runtime on this computer and never shared with remote devices.</p>
          <div id="settings-providers" class="provider-list" aria-live="polite"></div>
        </section>
        <section id="settings-panel-preferences" class="settings-panel" role="tabpanel" aria-labelledby="settings-tab-preferences" data-settings-panel="preferences" hidden>
          <h3 class="settings-section-title">Preferences</h3>
          <div class="settings-row"><div class="settings-row-text"><span class="settings-row-label"><label for="settings-notifications">Desktop notifications</label></span><span class="settings-row-desc"><span>Notify when a turn finishes while the window is not focused.</span></span></div><div class="settings-row-control"><input id="settings-notifications" type="checkbox" class="settings-switch" /></div></div>
        </section>
        <div class="settings-actions"><button id="cancel-settings" type="button" class="ghost-button">Cancel</button><button id="save-settings" type="submit" class="primary-button">Save</button></div>
      </div>
      </form>
    </dialog>
    <dialog id="auth-prompt-dialog" class="settings-dialog auth-prompt-dialog" aria-labelledby="auth-prompt-title">
      <form id="auth-prompt-form" method="dialog">
        <div class="settings-heading"><h2 id="auth-prompt-title">Provider sign-in</h2></div>
        <label id="auth-prompt-label" class="auth-prompt-label"><span id="auth-prompt-message"></span><span id="auth-prompt-field" class="auth-prompt-field"></span></label>
        <div class="settings-actions"><button id="auth-prompt-cancel" type="button" class="ghost-button">Cancel</button><button id="auth-prompt-submit" type="submit" class="primary-button">Continue</button></div>
      </form>
    </dialog>
    <dialog id="shortcuts-dialog" class="settings-dialog shortcuts-dialog" aria-labelledby="shortcuts-title">
      <form method="dialog">
        <div class="settings-heading"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button id="close-shortcuts" type="button" class="icon-button" aria-label="Close shortcuts">${renderIcon(X)}</button></div>
        <div class="shortcut-table" id="shortcut-table"></div>
      </form>
    </dialog>
    <div id="command-palette" class="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" hidden>
      <div class="command-palette-box">
        <input id="palette-input" type="text" placeholder="Type a command…" aria-label="Search commands" autocomplete="off" />
        <div id="palette-list" class="command-palette-list" role="listbox" aria-label="Commands"></div>
      </div>
    </div>
  </div>
`

export const connection = requiredElement("connection")
export const connectionText = requiredElement("connection-text")
export const projectMenuTrigger = requiredElement<HTMLButtonElement>("project-menu-trigger")
export const projectMenuLabel = requiredElement("project-menu-label")
export const projectMenu = requiredElement("project-menu")
export const projectList = requiredElement("project-list")
export const recentSessions = requiredElement("recent-sessions")
export const recentList = requiredElement("recent-list")
export const sessionTitle = requiredElement("session-title")
export const modelMenuTrigger = requiredElement<HTMLButtonElement>("model-menu-trigger")
export const modelMenuLabel = requiredElement("model-menu-label")
export const modelMenu = requiredElement("model-menu")
export const effortMenuTrigger = requiredElement<HTMLButtonElement>("effort-menu-trigger")
export const effortMenuLabel = requiredElement("effort-menu-label")
export const effortMenu = requiredElement("effort-menu")
export const attachButton = requiredElement<HTMLButtonElement>("attach-button")
export const attachInput = requiredElement<HTMLInputElement>("attach-input")
export const attachmentChips = requiredElement("attachment-chips")
export const taskMonitorDock = requiredElement("task-monitor")
export const goalPanel = requiredElement("goal-panel")
export const activityPlan = requiredElement("activity-plan")
export const sessionSearchInput = requiredElement<HTMLInputElement>("session-search")
export const paletteOverlay = requiredElement("command-palette")
export const paletteInput = requiredElement<HTMLInputElement>("palette-input")
export const paletteList = requiredElement("palette-list")
export const shortcutsDialog = requiredElement<HTMLDialogElement>("shortcuts-dialog")
export const shortcutTable = requiredElement("shortcut-table")
export const messageStream = requiredElement("message-stream")
export const jumpLatest = requiredElement<HTMLButtonElement>("jump-latest")
export const pendingInputDock = requiredElement("pending-input-dock")
export const notice = requiredElement("notice")
export const noticeText = requiredElement("notice-text")
export const retry = requiredElement<HTMLButtonElement>("retry")
export const contextMeter = requiredElement("context-meter")
export const prompt = requiredElement<HTMLTextAreaElement>("prompt")
export const send = requiredElement<HTMLButtonElement>("send")
export const steer = requiredElement<HTMLButtonElement>("steer")
export const interrupt = requiredElement<HTMLButtonElement>("interrupt")
export const composerMenuTrigger = requiredElement<HTMLButtonElement>("composer-menu-trigger")
export const composerMenu = requiredElement("composer-menu")
export const compactContext = requiredElement<HTMLButtonElement>("compact-context")
export const slashCommandMenu = requiredElement("slash-command-menu")
export const sidebar = requiredElement("sidebar")
export const sidebarResizeHandle = requiredElement("sidebar-resize-handle")
export const inspector = requiredElement("inspector")
export const inspectorResizeHandle = requiredElement("inspector-resize-handle")
export const inspectorToggle = requiredElement<HTMLButtonElement>("toggle-inspector")
export const inspectorContextBody = requiredElement("inspector-context")
export const inspectorUsageBody = requiredElement("inspector-usage")
export const filesUnavailable = requiredElement("files-unavailable")
export const fileTree = requiredElement("file-tree")
export const filePreview = requiredElement("file-preview")
export const newSessionButton = requiredElement<HTMLButtonElement>("new-session")
export const sidebarToggle = requiredElement<HTMLButtonElement>("toggle-sidebar")
export const settingsDialog = requiredElement<HTMLDialogElement>("settings-dialog")
export const settingsForm = requiredElement<HTMLFormElement>("settings-form")
export const settingsApiKey = requiredElement<HTMLInputElement>("settings-api-key")
export const settingsBaseUrl = requiredElement<HTMLInputElement>("settings-base-url")
export const settingsModel = requiredElement<HTMLInputElement>("settings-model")
export const settingsReasoning = requiredElement<HTMLSelectElement>("settings-reasoning")
export const settingsKeyStatus = requiredElement("settings-key-status")
export const settingsNotifications = requiredElement<HTMLInputElement>("settings-notifications")
export const saveSettingsButton = requiredElement<HTMLButtonElement>("save-settings")
export const settingsProviders = requiredElement("settings-providers")
export const authPromptDialog = requiredElement<HTMLDialogElement>("auth-prompt-dialog")
export const authPromptForm = requiredElement<HTMLFormElement>("auth-prompt-form")
export const authPromptMessage = requiredElement("auth-prompt-message")
export const authPromptField = requiredElement("auth-prompt-field")

export function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}
export const composerForm = requiredElement<HTMLFormElement>("composer")
