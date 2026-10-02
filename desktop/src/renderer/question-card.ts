import { type QuestionSelection, canConfirmQuestion } from "./question-state.ts"
import { type Question } from "./timeline-model.ts"
import { escapeAttribute, escapeHtml } from "./app/html.ts"

export function questionCardMarkup(question: Question, selection: QuestionSelection) {
  return `<section class="stream-card card-question" data-stream-role="question" data-question-id="${escapeAttribute(question.toolCallId)}" aria-label="Rind asks">
    <div class="question-heading"><span class="question-dot" aria-hidden="true"></span><span>Your input needed</span></div>
    <div class="question-text">${escapeHtml(question.question)}</div>
    <form id="question-form" class="question-form">
      <div class="question-options" role="radiogroup" aria-label="Choose an answer">
        ${[...question.options, { label: "Write your own answer", description: "" }].map((option, index) => `<label class="question-option"><input type="radio" name="question-choice" data-question-option-index="${index}" value="${index}" /><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}
      </div>
      <textarea id="question-answer" aria-label="Your answer" rows="2" placeholder="Write an answer…" hidden>${escapeHtml(selection.customInput)}</textarea>
      <div class="question-footer"><span class="question-error" role="status"></span><button type="submit" class="primary-button">Send answer</button></div>
    </form>
  </section>`
}

// Never replace a live question's controls during unrelated stream events.
// This preserves keyboard focus, IME composition, selections and draft text.
export function syncQuestionCard(card: HTMLElement, selection: QuestionSelection, optionCount: number) {
  for (const input of card.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
    input.checked = Number(input.value) === selection.selectedIndex
    input.disabled = Boolean(selection.submitting)
    input.closest("label")?.classList.toggle("selected", input.checked)
  }
  const textarea = card.querySelector<HTMLTextAreaElement>("textarea")!
  textarea.hidden = selection.selectedIndex !== optionCount
  textarea.disabled = Boolean(selection.submitting)
  if (document.activeElement !== textarea && textarea.value !== selection.customInput) textarea.value = selection.customInput
  const submit = card.querySelector<HTMLButtonElement>("[type=submit]")!
  submit.disabled = !canConfirmQuestion(selection, optionCount)
  submit.textContent = selection.submitting ? "Sending…" : "Send answer"
  card.setAttribute("aria-busy", String(Boolean(selection.submitting)))
  card.querySelector<HTMLElement>(".question-error")!.textContent = selection.error || ""
}
