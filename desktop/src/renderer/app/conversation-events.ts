import { Quote, renderIcon } from "../icons.ts"
import {
  collectQuestionAnswers,
  selectQuestionOption,
  setQuestionStep,
  updateQuestionInput,
} from "../question-state.ts"
import { syncQuestionCard } from "../question-card.ts"
import { retryLastPrompt, selectSlashCommand, setPrompt } from "./composer.ts"
import { interrupt, jumpLatest, messageStream, prompt, retry } from "./dom.ts"
import { answerQuestion, cancelActiveTurn, questionSelectionFor, restartRuntime, runAction } from "./runtime.ts"
import { openToolFile } from "./files-panel.ts"
import { chatProject, switchSession } from "./sessions.ts"
import { render } from "./shell.ts"
import { state, toolOpenRequests, vars } from "./state.ts"
import { keepToolHeaderVisible, setToolExpanded, toggleChangeSummaryExpanded, toolHeaderOffset } from "./stream.ts"

function insertQuotedText(raw: string) {
  const quoted = raw.trim().split("\n").map((line) => `> ${line}`).join("\n")
  if (!quoted) return
  const next = prompt.value.trim() ? `${prompt.value.trimEnd()}\n\n${quoted}\n\n` : `${quoted}\n\n`
  setPrompt(next, true)
}

export function bindConversationEvents(): void {
  messageStream.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement
    const segment = target.closest<HTMLElement>(".segment-calls")?.closest<HTMLElement>(".work-segment")
    if (segment?.dataset.entryId) state.segmentFolds = new Map([...state.segmentFolds, [segment.dataset.entryId, true]])
  })
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

  const streamWrap = messageStream.parentElement
  let quotePill: HTMLButtonElement | null = null
  let selectedQuoteText = ""

  function hideQuotePill() {
    if (quotePill) quotePill.hidden = true
    selectedQuoteText = ""
  }

  function updateQuotePill() {
    const selection = window.getSelection?.()
    if (!selection || selection.isCollapsed || !streamWrap) {
      hideQuotePill()
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      hideQuotePill()
      return
    }
    const anchor = selection.anchorNode?.parentElement
    const focus = selection.focusNode?.parentElement
    const body = anchor?.closest(".turn-assistant .message-body") || focus?.closest(".turn-assistant .message-body")
    if (!body || !messageStream.contains(body)) {
      hideQuotePill()
      return
    }
    try {
      const range = selection.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const wrapRect = streamWrap.getBoundingClientRect()
      if (!rect.width) {
        hideQuotePill()
        return
      }
      if (!quotePill) {
        quotePill = document.createElement("button")
        quotePill.type = "button"
        quotePill.className = "quote-selection-pill"
        quotePill.innerHTML = `${renderIcon(Quote, "quote-pill-icon")}<span>Quote</span>`
        quotePill.addEventListener("mousedown", (event) => {
          event.preventDefault()
          if (selectedQuoteText) insertQuotedText(selectedQuoteText)
          hideQuotePill()
          window.getSelection?.()?.removeAllRanges?.()
        })
        streamWrap.append(quotePill)
      }
      selectedQuoteText = text
      const top = Math.max(8, rect.top - wrapRect.top - 34)
      const left = Math.min(wrapRect.width - 88, Math.max(12, rect.left - wrapRect.left + rect.width / 2 - 36))
      quotePill.style.top = `${top}px`
      quotePill.style.left = `${left}px`
      quotePill.hidden = false
    } catch {
      hideQuotePill()
    }
  }

  messageStream.addEventListener("mouseup", updateQuotePill)
  messageStream.addEventListener("keyup", updateQuotePill)

  streamWrap?.addEventListener("click", (event) => {
    const turnJump = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-turn-jump]")?.dataset.turnJump
    if (turnJump) {
      const node = messageStream.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(turnJump)}"]`)
      node?.scrollIntoView({ block: "start", behavior: "smooth" })
    }
  })

  messageStream.addEventListener("scroll", () => {
    const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
    if (nearBottom) jumpLatest.hidden = true
    hideQuotePill()
  })


  messageStream.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const copyMessage = target.closest<HTMLButtonElement>("[data-copy-message]")?.dataset.copyMessage
    if (copyMessage) {
      const entry = state.conversation.entries.find((item) => item.id === copyMessage)
      const content = entry && "content" in entry ? entry.content : ""
      if (content) runAction(() => navigator.clipboard.writeText(content))
      return
    }
    const quoteMessage = target.closest<HTMLButtonElement>("[data-quote-message]")?.dataset.quoteMessage
    if (quoteMessage) {
      const entry = state.conversation.entries.find((item) => item.id === quoteMessage)
      const content = entry && "content" in entry ? entry.content : ""
      if (content) insertQuotedText(content)
      return
    }
    const editMessage = target.closest<HTMLButtonElement>("[data-edit-message]")?.dataset.editMessage
    if (editMessage) {
      const entry = state.conversation.entries.find((item) => item.id === editMessage)
      if (entry?.kind === "user") setPrompt(entry.content, true)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-toggle-change-summary]")) {
      toggleChangeSummaryExpanded(state.viewedSessionId)
      render()
      return
    }
    const jumpTool = target.closest<HTMLButtonElement>("[data-jump-tool]")?.dataset.jumpTool
    if (jumpTool) {
      const row = messageStream.querySelector<HTMLElement>(`[data-tool-id="${CSS.escape(jumpTool)}"]`)
        || messageStream.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(jumpTool)}"]`)
      const segment = row?.closest<HTMLElement>(".work-segment")
      if (segment?.dataset.entryId) {
        state.segmentFolds = new Map([...state.segmentFolds, [segment.dataset.entryId, true]])
      }
      state.revealedTools.add(jumpTool)
      state.expandedTools = new Set([...state.expandedTools, jumpTool])
      render()
      requestAnimationFrame(() => {
        const targetNode = messageStream.querySelector<HTMLElement>(`[data-tool-id="${CSS.escape(jumpTool)}"]`)
        targetNode?.scrollIntoView({ block: "center", behavior: "smooth" })
      })
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
    const question = state.conversation.question
    if (!question) return
    const selection = questionSelectionFor(question)
    if (selection.submitting) return

    const stepTab = target.closest<HTMLButtonElement>("[data-step-tab]")
    if (stepTab) {
      const nextStep = Number(stepTab.dataset.stepTab)
      if (Number.isInteger(nextStep)) {
        state.questionSelection = setQuestionStep(selection, nextStep)
        render()
      }
      return
    }
    const navBtn = target.closest<HTMLButtonElement>("[data-question-nav]")
    if (navBtn) {
      const delta = navBtn.dataset.questionNav === "prev" ? -1 : 1
      state.questionSelection = setQuestionStep(selection, selection.activeStep + delta)
      render()
      return
    }
    const skipBtn = target.closest<HTMLButtonElement>("[data-question-skip]")
    if (skipBtn) {
      runAction(() => answerQuestion([]), state.viewedSessionId)
      return
    }
    const optionBtn = target.closest<HTMLButtonElement>("[data-question-option-index]")
    if (optionBtn) {
      const stepIdx = Number(optionBtn.dataset.questionStep ?? selection.activeStep)
      const optIdx = Number(optionBtn.dataset.questionOptionIndex)
      if (Number.isInteger(stepIdx) && Number.isInteger(optIdx)) {
        const nextSelection = selectQuestionOption(selection, stepIdx, optIdx, question.questions)
        state.questionSelection = nextSelection
        render()
        const optsLen = question.questions[stepIdx]?.options?.length ?? 0
        if (optIdx === optsLen && nextSelection.steps[stepIdx]?.customSelected) {
          messageStream
            .querySelector<HTMLTextAreaElement>(`textarea[data-question-custom-input="${stepIdx}"]`)
            ?.focus()
        }
      }
    }
  })

  messageStream.addEventListener("input", (event) => {
    const target = event.target as HTMLElement
    if (!(target instanceof HTMLTextAreaElement) || target.dataset.questionCustomInput === undefined) return
    const question = state.conversation.question
    if (!question) return
    const stepIdx = Number(target.dataset.questionCustomInput)
    if (!Number.isInteger(stepIdx)) return
    const selection = updateQuestionInput(questionSelectionFor(question), stepIdx, target.value)
    state.questionSelection = selection
    const card = messageStream.querySelector<HTMLElement>(".card-question")
    if (card) syncQuestionCard(card, selection, question.questions)
  })

  messageStream.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement
    if (!(target instanceof HTMLTextAreaElement) || target.dataset.questionCustomInput === undefined) return
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    const question = state.conversation.question
    if (!question) return
    event.preventDefault()
    const selection = questionSelectionFor(question)
    const answers = collectQuestionAnswers(selection, question.questions)
    if (answers) {
      runAction(() => answerQuestion(answers), state.viewedSessionId)
    } else if (selection.activeStep < question.questions.length - 1) {
      state.questionSelection = setQuestionStep(selection, selection.activeStep + 1)
      render()
    }
  })

  messageStream.addEventListener("submit", (event) => {
    event.preventDefault()
    if ((event.target as HTMLElement).id !== "question-form") return
    const question = state.conversation.question
    if (!question) return
    const answers = collectQuestionAnswers(questionSelectionFor(question), question.questions)
    if (answers) runAction(() => answerQuestion(answers), state.viewedSessionId)
  })
}
