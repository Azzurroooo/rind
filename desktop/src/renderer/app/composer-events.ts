import { composerKeyAction } from "../composer-keys.ts"
import { sameProjectPath as samePath } from "../project-selection.ts"
import { isExactSlashCommand, slashCommandMenu as buildSlashCommandMenu } from "../slash-commands.ts"
import { addAttachmentFiles, bindAttachmentEvents } from "./attachments-ui.ts"
import { closeComposerSelectMenus, selectEffort, selectModel, toggleEffortMenu, toggleModelMenu, toggleProjectMenu } from "./composer-menus.ts"
import { autoGrowPrompt, closeSlashCommandMenu, renderSlashCommandMenu, revealActiveSlashCommand, selectSlashCommand, sendPrompt, setPrompt } from "./composer.ts"
import { attachButton, attachInput, compactContext, composerForm, contextMeter, composerMenuTrigger, effortMenu, effortMenuTrigger, modelMenu, modelMenuTrigger, projectMenu, projectMenuTrigger, prompt, requiredElement, slashCommandMenu } from "./dom.ts"
import { toggleInspector } from "./inspector.ts"
import { runAction } from "./runtime.ts"
import { currentDraftKey, selectChatProject, sessionTurnActive } from "./sessions.ts"
import { render, renderComposerState } from "./shell.ts"
import { bindSendActions } from "./send-actions.ts"
import { bindMenuNavigation } from "../menu-navigation.ts"
import { compactCurrentSession } from "./slash-runner.ts"
import { state } from "./state.ts"

export function bindComposerEvents(): void {
  bindSendActions()
  requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(() => sendPrompt(), state.viewedSessionId) })
  for (const [trigger, menu] of [[modelMenuTrigger, modelMenu], [effortMenuTrigger, effortMenu], [projectMenuTrigger, projectMenu]] as const) {
    bindMenuNavigation(trigger, menu, () => { closeComposerSelectMenus(); render() })
  }

  prompt.addEventListener("input", () => {
    if (state.chatProjectPath) state.drafts[currentDraftKey()] = prompt.value
    autoGrowPrompt()
    renderSlashCommandMenu()
    renderComposerState()
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
    const viewed = state.viewedSessionId
    const lastPrompt = state.lastPrompts[viewed] || ""
    const action = composerKeyAction(event, {
      running: Boolean(viewed) && sessionTurnActive(viewed),
      empty: !prompt.value.trim(),
      canRecall: Boolean(lastPrompt.trim()),
    })
    if (action === "default") return
    event.preventDefault()
    if (action === "recall") {
      setPrompt(lastPrompt, true)
      return
    }
    runAction(() => sendPrompt(action === "steer" ? "steer" : "queue"), viewed)
  })

  contextMeter.addEventListener("click", () => runAction(() => toggleInspector("context"), state.viewedSessionId))

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

  bindAttachmentEvents()

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
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-model-choice]")
    if (option) runAction(() => selectModel({ id: option.dataset.modelChoice || "", providerId: option.dataset.modelProvider || "" }))
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
