import { sameProjectPath as samePath } from "../project-selection.ts"
import { isExactSlashCommand, slashCommandMenu as buildSlashCommandMenu } from "../slash-commands.ts"
import { addAttachmentFiles } from "./attachments-ui.ts"
import { closeComposerSelectMenus, selectEffort, selectModel, toggleEffortMenu, toggleModelMenu, toggleProjectMenu } from "./composer-menus.ts"
import { autoGrowPrompt, closeSlashCommandMenu, renderSlashCommandMenu, revealActiveSlashCommand, selectSlashCommand, sendPrompt } from "./composer.ts"
import { attachButton, attachInput, compactContext, composerForm, composerMenuTrigger, effortMenu, effortMenuTrigger, modelMenu, modelMenuTrigger, projectMenu, projectMenuTrigger, prompt, requiredElement, slashCommandMenu } from "./dom.ts"
import { showGoalPanel } from "./inspector.ts"
import { runAction } from "./runtime.ts"
import { currentDraftKey, selectChatProject } from "./sessions.ts"
import { render } from "./shell.ts"
import { compactCurrentSession } from "./slash-runner.ts"
import { state } from "./state.ts"

export function bindComposerEvents(): void {
    requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(sendPrompt, state.viewedSessionId) })

  prompt.addEventListener("input", () => {
    if (state.chatProjectPath) state.drafts[currentDraftKey()] = prompt.value
    autoGrowPrompt()
    renderSlashCommandMenu()
  })

  prompt.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return
    const menu = buildSlashCommandMenu(state.slashCommands, prompt.value)
    if (state.slashMenuOpen && menu && menu.commands.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const offset = event.key === "ArrowDown" ? 1 : -1
        state.slashMenuActiveIndex = (state.slashMenuActiveIndex + offset + menu.commands.length) % menu.commands.length
        renderSlashCommandMenu()
        revealActiveSlashCommand()
        return
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !isExactSlashCommand(state.slashCommands, prompt.value))) {
        event.preventDefault()
        selectSlashCommand(menu.commands[state.slashMenuActiveIndex] || menu.commands[0])
        return
      }
    }
    if (event.key === "Escape" && state.slashMenuOpen) {
      event.preventDefault()
      closeSlashCommandMenu()
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      runAction(sendPrompt, state.viewedSessionId)
    }
  })

  composerMenuTrigger.addEventListener("click", () => {
    closeComposerSelectMenus()
    state.composerMenuOpen = !state.composerMenuOpen
    render()
  })

  attachButton.addEventListener("click", () => {
    if (attachButton.disabled) return
    attachInput.value = ""
    attachInput.click()
  })

  attachInput.addEventListener("change", () => {
    const files = Array.from(attachInput.files || [])
    if (files.length) addAttachmentFiles(files)
  })

  prompt.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || [])
    if (!files.length) return
    event.preventDefault()
    addAttachmentFiles(files)
  })

  compactContext.addEventListener("click", () => {
    state.composerMenuOpen = false
    render()
      runAction(compactCurrentSession, state.viewedSessionId)
  })

  requiredElement("toggle-goal").addEventListener("click", () => {
    state.composerMenuOpen = false
    showGoalPanel(!state.goal.visible)
  })

  composerForm.addEventListener("dragover", (event) => {
    event.preventDefault()
    composerForm.classList.add("drag-over")
  })

  composerForm.addEventListener("dragleave", () => composerForm.classList.remove("drag-over"))

  composerForm.addEventListener("drop", (event) => {
    event.preventDefault()
    composerForm.classList.remove("drag-over")
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length) addAttachmentFiles(files)
  })

  slashCommandMenu.addEventListener("pointermove", (event) => {
    const commandName = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-slash-command]")?.dataset.slashCommand
    if (!commandName) return
    const index = buildSlashCommandMenu(state.slashCommands, prompt.value)?.commands.findIndex((command) => command.name === commandName) ?? -1
    if (index < 0 || index === state.slashMenuActiveIndex) return
    state.slashMenuActiveIndex = index
    renderSlashCommandMenu()
    revealActiveSlashCommand()
  })

  slashCommandMenu.addEventListener("click", (event) => {
    const commandName = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-slash-command]")?.dataset.slashCommand
    const command = state.slashCommands.find((item) => item.name === commandName)
    if (command) selectSlashCommand(command)
  })

  modelMenuTrigger.addEventListener("click", () => runAction(toggleModelMenu))

  modelMenu.addEventListener("click", (event) => {
    const model = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-model-choice]")?.dataset.modelChoice
    if (model) runAction(() => selectModel(model))
  })

  effortMenuTrigger.addEventListener("click", () => runAction(toggleEffortMenu))

  effortMenu.addEventListener("click", (event) => {
    const effort = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-effort-choice]")?.dataset.effortChoice
    if (effort) runAction(() => selectEffort(effort), state.viewedSessionId)
  })

  projectMenuTrigger.addEventListener("click", () => toggleProjectMenu())

  projectMenu.addEventListener("click", (event) => {
    if (state.viewedSessionId) {
      state.projectMenuOpen = false
      render()
      return
    }
    const path = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-project-choice]")?.dataset.projectChoice
    if (!path || samePath(path, state.chatProjectPath)) {
      state.projectMenuOpen = false
      render()
      return
    }
    state.projectMenuOpen = false
    render()
    runAction(() => selectChatProject(path))
  })
}
