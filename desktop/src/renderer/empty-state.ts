// Empty-stream guidance: what the user sees before the first message of a
// session. Three states, most urgent problem first — missing API key, missing
// project, then starter prompts. Pure markup; click handling stays in index.ts.

export type EmptyStateView = {
  hasProject: boolean
  ready: boolean
  hasApiKey: boolean
}

export type StarterPrompt = {
  title: string
  detail: string
  prompt: string
}

export const starterPrompts: StarterPrompt[] = [
  { title: "Explore this codebase", detail: "Architecture and key entry points", prompt: "Explore this codebase: explain the architecture, the key entry points, and how data flows through it." },
  { title: "Find and fix a bug", detail: "Recent changes, verified by tests", prompt: "Look for bugs in the recent changes, fix what you find, and prove the fix with tests." },
  { title: "Add missing tests", detail: "Focused coverage where it matters", prompt: "Find important code that lacks test coverage and add focused tests for it." },
  { title: "What can you do?", detail: "Tools and capabilities", prompt: "Show me which tools you have in this workspace and what you can do with them." },
]

export function renderEmptyState(view: EmptyStateView, brandMarkUrl: string): string {
  if (!view.hasApiKey) {
    return `
      <img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
      <p class="stream-empty-title">Connect a model provider</p>
      <p class="subtle">Rind needs an API key in ~/.rind/settings.json before it can work.</p>
      <div class="stream-empty-actions"><button type="button" class="primary-button" data-empty-action="settings">Open settings</button></div>
    `
  }
  if (!view.hasProject) {
    return `
      <img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
      <p class="stream-empty-title">Add a project</p>
      <p class="subtle">Pick a folder for Rind to work in. Sessions are saved per project.</p>
      <div class="stream-empty-actions"><button type="button" class="primary-button" data-empty-action="add-project">Add project</button></div>
    `
  }
  if (!view.ready) {
    return `
      <img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
      <p class="stream-empty-title">Starting…</p>
      <p class="subtle">Pick a project and start a runtime to begin.</p>
    `
  }
  return `
    <img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
    <p class="stream-empty-title">Start a task</p>
    <div class="starter-list">
      ${starterPrompts.map((starter) => `
        <button type="button" class="starter-item" data-empty-prompt="${escapeAttribute(starter.prompt)}">
          <strong>${escapeHtml(starter.title)}</strong>
          <small>${escapeHtml(starter.detail)}</small>
        </button>
      `).join("")}
    </div>
  `
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}
