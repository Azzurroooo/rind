import { canConfirmQuestion, questionAnswer, selectQuestionOption, updateQuestionInput } from "../question-state.ts"
import { retryLastPrompt, selectSlashCommand, setPrompt } from "./composer.ts"
import { interrupt, jumpLatest, messageStream, requiredElement, retry } from "./dom.ts"
import { answerQuestion, cancelActiveTurn, questionSelectionFor, restartRuntime, runAction } from "./runtime.ts"
import { openToolFile } from "./files-panel.ts"
import { chatProject, switchSession } from "./sessions.ts"
import { render } from "./shell.ts"
import { state, toolOpenRequests, vars } from "./state.ts"
import { keepToolHeaderVisible, setToolExpanded, toolHeaderOffset } from "./stream.ts"

export function bindConversationEvents(): void {
  messageStream.addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-starter]")?.dataset.starter
    if (value) setPrompt(value, true)
  })

  interrupt.addEventListener("click", () => cancelActiveTurn(state.viewedSessionId))

  retry.addEventListener("click", () => runAction(async () => {
    const project = chatProject()
    if (!project?.available) return
    await restartRuntime(project.path)
    state.notice = ""
    render()
  }))

  jumpLatest.addEventListener("click", () => {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  })

  messageStream.addEventListener("scroll", () => {
    const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
    if (nearBottom) jumpLatest.hidden = true
  })


  messageStream.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const copyMessage = target.closest<HTMLButtonElement>("[data-copy-message]")?.dataset.copyMessage
    if (copyMessage) {
      const entry = state.conversation.entries.find((item) => item.id === copyMessage)
      const content = entry && (entry.kind === "user" || entry.kind === "assistant") ? entry.content : ""
      if (content) runAction(() => navigator.clipboard.writeText(content))
      return
    }
    const editMessage = target.closest<HTMLButtonElement>("[data-edit-message]")?.dataset.editMessage
    if (editMessage) {
      const entry = state.conversation.entries.find((item) => item.id === editMessage)
      if (entry?.kind === "user") setPrompt(entry.content, true)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-retry-turn]")) {
      runAction(retryLastPrompt, state.viewedSessionId)
      return
    }
    const segmentTrigger = target.closest<HTMLButtonElement>("[data-toggle-segment]")
    if (segmentTrigger?.dataset.toggleSegment) {
      const expanded = segmentTrigger.getAttribute("aria-expanded") === "true"
      state.segmentFolds = new Map([...state.segmentFolds, [segmentTrigger.dataset.toggleSegment, !expanded]])
      render()
      return
    }
    const earlierId = target.closest<HTMLButtonElement>("[data-segment-earlier]")?.dataset.segmentEarlier
    if (earlierId) {
      state.segmentFolds = new Map([...state.segmentFolds, [earlierId, true]])
      render()
      return
    }
    const moreKey = target.closest<HTMLButtonElement>("[data-tool-more]")?.dataset.toolMore
    if (moreKey) {
      const next = new Set(state.toolBodiesShown)
      if (next.has(moreKey)) next.delete(moreKey)
      else next.add(moreKey)
      state.toolBodiesShown = next
      render()
      return
    }
    const openFile = target.closest<HTMLButtonElement>("[data-open-file]")?.dataset.openFile
    if (openFile) {
      runAction(() => openToolFile(openFile))
      return
    }
    const toggle = target.closest<HTMLButtonElement>("[data-toggle-tool]")
    if (toggle?.dataset.toggleTool) {
      const id = toggle.dataset.toggleTool
      const headerOffset = toolHeaderOffset(id)
      if (state.expandedTools.has(id)) {
        toolOpenRequests.set(id, (toolOpenRequests.get(id) || 0) + 1)
        vars.toolAnimationUntil = performance.now() + 380
        const next = new Set(state.expandedTools)
        next.delete(id)
        state.expandedTools = next
        setToolExpanded(id, false)
        keepToolHeaderVisible(id, headerOffset)
        return
      }
      const requestId = (toolOpenRequests.get(id) || 0) + 1
      toolOpenRequests.set(id, requestId)
      vars.toolAnimationUntil = performance.now() + 380
      state.revealedTools.add(id)
      render()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!state.revealedTools.has(id) || toolOpenRequests.get(id) !== requestId) return
          const next = new Set(state.expandedTools)
          next.add(id)
          state.expandedTools = next
          setToolExpanded(id, true)
          keepToolHeaderVisible(id, headerOffset)
        })
      })
      return
    }
    const copy = target.closest<HTMLButtonElement>(".copy-code")
    if (copy?.dataset.copy) {
      runAction(() => navigator.clipboard.writeText(copy.dataset.copy || ""))
      return
    }
    const commandName = target.closest<HTMLButtonElement>("[data-command-prefill]")?.dataset.commandPrefill
    if (commandName) {
      const command = state.slashCommands.find((item) => item.name === commandName)
      if (command) selectSlashCommand(command)
      return
    }
    const commandSessionId = target.closest<HTMLButtonElement>("[data-command-session-id]")?.dataset.commandSessionId
    if (commandSessionId) {
      runAction(() => switchSession(commandSessionId), commandSessionId)
      return
    }
  })

  messageStream.addEventListener("change", (event) => {
    const questionOption = (event.target as HTMLElement).closest<HTMLInputElement>("[data-question-option-index]")
    if (questionOption && state.conversation.question) {
      const index = Number(questionOption.dataset.questionOptionIndex)
      if (Number.isInteger(index)) {
        const question = state.conversation.question
        const selection = questionSelectionFor(question)
        if (selection.submitting) return
        state.questionSelection = selectQuestionOption(selection, index, question.options.length)
        render()
        if (index === question.options.length) requiredElement<HTMLTextAreaElement>("question-answer").focus()
      }
    }
  })

  messageStream.addEventListener("input", (event) => {
    const target = event.target as HTMLElement
    if (target.id !== "question-answer" || !(target instanceof HTMLTextAreaElement) || !state.conversation.question) return
    const selection = updateQuestionInput(questionSelectionFor(state.conversation.question), target.value)
    state.questionSelection = selection
    const form = requiredElement<HTMLFormElement>("question-form")
    const confirm = form.querySelector<HTMLButtonElement>("[type=submit]")
    if (confirm) confirm.disabled = !canConfirmQuestion(selection, state.conversation.question.options.length)
  })

  messageStream.addEventListener("submit", (event) => {
    event.preventDefault()
    if ((event.target as HTMLElement).id !== "question-form") return
    const question = state.conversation.question
    if (!question) return
    const answer = questionAnswer(questionSelectionFor(question), question.options)
    if (answer) runAction(() => answerQuestion(answer), state.viewedSessionId)
  })
}
