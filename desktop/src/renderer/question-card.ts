import { parseOptionLabel, type UserQuestionItem } from "../preload/types.ts"
import {
  answeredStepCount,
  canConfirmQuestion,
  stepAnswers,
  type QuestionSelection,
} from "./question-state.ts"
import { type Entry, type Question } from "./timeline-model.ts"
import { escapeAttribute, escapeHtml } from "./app/html.ts"

const CHECK_SVG = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`

function indicatorMarkup(multiple: boolean, checked: boolean): string {
  const kind = multiple ? "checkbox" : "radio"
  const inner = multiple ? CHECK_SVG : `<span class="question-radio-dot"></span>`
  return `<span class="question-indicator ${kind}${checked ? " checked" : ""}" aria-hidden="true">${inner}</span>`
}

export function questionCardMarkup(question: Question, selection: QuestionSelection): string {
  const items = question.questions
  const total = items.length
  const safeStep = Math.min(selection.activeStep, Math.max(0, total - 1))

  const stepTabs =
    total > 1
      ? `<div class="question-steps" role="tablist" aria-label="Question steps">${items
          .map((q, idx) => {
            const done = stepAnswers(q, selection.steps[idx]).length > 0
            const active = idx === safeStep
            const label = q.header || `Q${idx + 1}`
            return `<button type="button" role="tab" class="question-step-pill${active ? " active" : ""}${done ? " done" : ""}" data-step-tab="${idx}" aria-selected="${active}"><span class="question-step-num" aria-hidden="true">${done ? CHECK_SVG : idx + 1}</span><span class="question-step-label">${escapeHtml(label)}</span></button>`
          })
          .join("")}</div>`
      : ""

  const panes = items
    .map((q, stepIdx) => {
      const opts = q.options ?? []
      const draft = selection.steps[stepIdx] ?? {
        pickedIndices: [],
        customSelected: opts.length === 0,
        customInput: "",
      }
      const multiple = Boolean(q.multiple)
      const optionButtons = opts
        .map((opt, optIdx) => {
          const { text, recommended } = parseOptionLabel(opt.label)
          const selected = multiple
            ? draft.pickedIndices.includes(optIdx)
            : !draft.customSelected && draft.pickedIndices[0] === optIdx
          return `<button type="button" role="${multiple ? "checkbox" : "radio"}" aria-checked="${selected}" class="question-option${selected ? " selected" : ""}" data-question-step="${stepIdx}" data-question-option-index="${optIdx}">${indicatorMarkup(multiple, selected)}<span class="question-option-body"><span class="question-option-title-row"><strong>${escapeHtml(text)}</strong>${recommended ? `<span class="question-rec-badge">Recommended</span>` : ""}</span>${opt.description ? `<small>${escapeHtml(opt.description)}</small>` : ""}</span></button>`
        })
        .join("")

      const customSection =
        opts.length > 0
          ? `<div class="question-custom-option${draft.customSelected ? " selected" : ""}" data-question-custom-wrap="${stepIdx}"><button type="button" role="${multiple ? "checkbox" : "radio"}" aria-checked="${draft.customSelected}" class="question-custom-trigger" data-question-step="${stepIdx}" data-question-option-index="${opts.length}">${indicatorMarkup(multiple, draft.customSelected)}<span class="question-custom-label">Write your own answer…</span></button><div class="question-custom-input-wrap" data-question-custom-box="${stepIdx}"${draft.customSelected ? "" : " hidden"}><textarea data-question-custom-input="${stepIdx}" aria-label="Your answer" rows="2" placeholder="Type your answer…">${escapeHtml(draft.customInput)}</textarea></div></div>`
          : `<div class="question-open-input"><textarea data-question-custom-input="${stepIdx}" aria-label="Your answer" rows="2" placeholder="Type your answer…">${escapeHtml(draft.customInput)}</textarea></div>`

      return `<div class="question-step-pane" data-step-index="${stepIdx}"${stepIdx === safeStep ? "" : " hidden"}><div class="question-prompt-row"><div class="question-text">${escapeHtml(q.question)}</div>${multiple ? `<span class="question-mode-pill">Select all that apply</span>` : ""}</div><div class="question-options" role="${opts.length > 0 ? (multiple ? "group" : "radiogroup") : "group"}" aria-label="${escapeAttribute(q.question)}">${optionButtons}${customSection}</div></div>`
    })
    .join("")

  return `<section class="stream-card card-question" data-stream-role="question" data-question-id="${escapeAttribute(question.toolCallId)}" aria-label="Rind asks">
    <div class="question-heading"><span class="question-heading-lead"><span class="question-dot" aria-hidden="true"></span><span>${total > 1 ? "Questions" : "Clarification"}</span></span>${total > 1 ? `<span class="question-step-counter">${safeStep + 1} / ${total}</span>` : ""}</div>
    ${stepTabs}
    <form id="question-form" class="question-form">
      ${panes}
      <div class="question-footer">
        <div class="question-footer-left">
          <button type="button" class="question-btn-ghost" data-question-skip="true">Skip</button>
          <button type="button" class="question-btn-secondary" data-question-nav="prev"${total > 1 && safeStep > 0 ? "" : " hidden"}>Back</button>
        </div>
        <span class="question-error" role="status"></span>
        <div class="question-footer-right">
          <button type="button" class="question-btn-secondary" data-question-nav="next"${total > 1 && safeStep < total - 1 ? "" : " hidden"}>Next</button>
          <button type="submit" class="primary-button question-submit-btn">Send answer</button>
        </div>
      </div>
    </form>
  </section>`
}

// Never replace a live question's controls during unrelated stream events.
// This preserves keyboard focus, IME composition, selections and draft text.
export function syncQuestionCard(
  card: HTMLElement,
  selection: QuestionSelection,
  questions: readonly UserQuestionItem[],
): void {
  const total = questions.length
  const safeStep = Math.min(selection.activeStep, Math.max(0, total - 1))
  const busy = Boolean(selection.submitting)

  const counter = card.querySelector<HTMLElement>(".question-step-counter")
  if (counter) counter.textContent = `${safeStep + 1} / ${total}`

  for (const pill of card.querySelectorAll<HTMLButtonElement>("[data-step-tab]")) {
    const idx = Number(pill.dataset.stepTab)
    const done = stepAnswers(questions[idx], selection.steps[idx]).length > 0
    const active = idx === safeStep
    pill.classList.toggle("active", active)
    pill.classList.toggle("done", done)
    pill.setAttribute("aria-selected", String(active))
    pill.disabled = busy
    const num = pill.querySelector<HTMLElement>(".question-step-num")
    if (num) num.innerHTML = done ? CHECK_SVG : String(idx + 1)
  }

  for (const pane of card.querySelectorAll<HTMLElement>("[data-step-index]")) {
    const stepIdx = Number(pane.dataset.stepIndex)
    pane.hidden = stepIdx !== safeStep
    const q = questions[stepIdx]
    const opts = q?.options ?? []
    const draft = selection.steps[stepIdx]
    const multiple = Boolean(q?.multiple)

    for (const btn of pane.querySelectorAll<HTMLButtonElement>(".question-option")) {
      const optIdx = Number(btn.dataset.questionOptionIndex)
      const selected = Boolean(
        draft &&
          (multiple
            ? draft.pickedIndices.includes(optIdx)
            : !draft.customSelected && draft.pickedIndices[0] === optIdx),
      )
      btn.classList.toggle("selected", selected)
      btn.setAttribute("aria-checked", String(selected))
      btn.disabled = busy
      btn.querySelector(".question-indicator")?.classList.toggle("checked", selected)
    }

    const customWrap = pane.querySelector<HTMLElement>(`[data-question-custom-wrap="${stepIdx}"]`)
    if (customWrap && draft) {
      customWrap.classList.toggle("selected", draft.customSelected)
      const trigger = customWrap.querySelector<HTMLButtonElement>(".question-custom-trigger")
      if (trigger) {
        trigger.setAttribute("aria-checked", String(draft.customSelected))
        trigger.disabled = busy
        trigger.querySelector(".question-indicator")?.classList.toggle("checked", draft.customSelected)
      }
      const box = customWrap.querySelector<HTMLElement>(`[data-question-custom-box="${stepIdx}"]`)
      if (box) box.hidden = !draft.customSelected
    }

    const textarea = pane.querySelector<HTMLTextAreaElement>(
      `textarea[data-question-custom-input="${stepIdx}"]`,
    )
    if (textarea && draft) {
      textarea.disabled = busy
      if (opts.length === 0) textarea.hidden = false
      if (document.activeElement !== textarea && textarea.value !== draft.customInput) {
        textarea.value = draft.customInput
      }
    }
  }

  const skipBtn = card.querySelector<HTMLButtonElement>("[data-question-skip]")
  if (skipBtn) skipBtn.disabled = busy

  const prevBtn = card.querySelector<HTMLButtonElement>('[data-question-nav="prev"]')
  if (prevBtn) {
    prevBtn.hidden = !(total > 1 && safeStep > 0)
    prevBtn.disabled = busy
  }

  const allDone = canConfirmQuestion(selection, questions)
  const currentDone = stepAnswers(questions[safeStep], selection.steps[safeStep]).length > 0
  const nextBtn = card.querySelector<HTMLButtonElement>('[data-question-nav="next"]')
  if (nextBtn) {
    nextBtn.hidden = !(total > 1 && safeStep < total - 1 && !allDone)
    nextBtn.disabled = busy || !currentDone
  }

  const doneCount = answeredStepCount(selection, questions)
  const submit = card.querySelector<HTMLButtonElement>("[type=submit]")
  if (submit) {
    submit.disabled = !allDone
    submit.textContent = busy
      ? "Sending…"
      : total > 1
        ? `Submit (${doneCount}/${total})`
        : "Send answer"
  }

  card.setAttribute("aria-busy", String(busy))
  const errEl = card.querySelector<HTMLElement>(".question-error")
  if (errEl) errEl.textContent = selection.error || ""
}

export function questionReceiptMarkup(
  entry: Extract<Entry, { kind: "question_receipt" }>,
): string {
  const skipped = Boolean(entry.skipped)
  const rows = entry.items
    .map((item) => {
      const headerHtml = item.header
        ? `<span class="question-receipt-header">${escapeHtml(item.header)}</span>`
        : ""
      const valuesHtml = skipped
        ? ""
        : `<div class="question-receipt-values">${
            item.answers.length > 0
              ? item.answers
                  .map(
                    (ans) =>
                      `<span class="question-receipt-pill">${CHECK_SVG}<span>${escapeHtml(parseOptionLabel(ans).text)}</span></span>`,
                  )
                  .join("")
              : `<span class="question-receipt-empty">—</span>`
          }</div>`
      return `<div class="question-receipt-row"><div class="question-receipt-prompt">${headerHtml}<span>${escapeHtml(item.question)}</span></div>${valuesHtml}</div>`
    })
    .join("")

  return `<section class="stream-card card-question-receipt${skipped ? " skipped" : ""}" data-entry-id="${escapeAttribute(entry.id)}" aria-label="${skipped ? "Question skipped" : "Answered question"}"><div class="question-receipt-head"><span class="question-receipt-lead">${skipped ? "" : CHECK_SVG}<span>${skipped ? "Question skipped" : "Answered"}</span></span></div><div class="question-receipt-body">${rows}</div></section>`
}
