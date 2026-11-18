import { parseOptionLabel, type UserQuestionItem } from "../preload/types.ts"

export type QuestionStepDraft = {
  pickedIndices: number[]
  customSelected: boolean
  customInput: string
}

export type QuestionSelection = {
  questionId: string
  activeStep: number
  steps: QuestionStepDraft[]
  submitting?: boolean
  error?: string
}

export function createQuestionSelection(
  questionId: string,
  questions: readonly UserQuestionItem[],
): QuestionSelection {
  const steps: QuestionStepDraft[] = questions.map((q) => {
    const opts = q.options ?? []
    const hasRecFirst = opts.length > 0 && parseOptionLabel(opts[0]!.label).recommended
    return {
      pickedIndices: !q.multiple && hasRecFirst ? [0] : [],
      customSelected: opts.length === 0,
      customInput: "",
    }
  })
  return {
    questionId,
    activeStep: 0,
    steps,
  }
}

export function setQuestionStep(
  selection: QuestionSelection,
  stepIndex: number,
): QuestionSelection {
  const total = selection.steps.length
  if (total === 0) return selection
  const nextStep = Math.max(0, Math.min(total - 1, Math.floor(stepIndex)))
  return { ...selection, activeStep: nextStep, error: "" }
}

export function stepAnswers(
  question: UserQuestionItem | undefined,
  draft: QuestionStepDraft | undefined,
): string[] {
  if (!question || !draft) return []
  const opts = question.options ?? []
  const custom = draft.customInput.trim()
  if (question.multiple) {
    const chosen = draft.pickedIndices
      .map((i) => opts[i]?.label)
      .filter((label): label is string => Boolean(label))
    return draft.customSelected && custom ? [...chosen, custom] : chosen
  }
  if (draft.customSelected) {
    return custom ? [custom] : []
  }
  const idx = draft.pickedIndices[0]
  const label = idx !== undefined ? opts[idx]?.label : undefined
  return label ? [label] : []
}

function findNextUnansweredStep(
  questions: readonly UserQuestionItem[],
  steps: readonly QuestionStepDraft[],
  fromStep: number,
): number {
  const total = questions.length
  for (let offset = 1; offset < total; offset += 1) {
    const idx = (fromStep + offset) % total
    if (stepAnswers(questions[idx], steps[idx]).length === 0) return idx
  }
  return -1
}

export function selectQuestionOption(
  selection: QuestionSelection,
  stepIndex: number,
  optionIndex: number,
  questions: readonly UserQuestionItem[],
): QuestionSelection {
  const q = questions[stepIndex]
  if (!q) return selection
  const optionCount = q.options?.length ?? 0
  const isCustom = optionIndex >= optionCount
  const steps = selection.steps.map((draft, idx) => {
    if (idx !== stepIndex) return draft
    if (q.multiple) {
      if (isCustom) return { ...draft, customSelected: !draft.customSelected }
      const exists = draft.pickedIndices.includes(optionIndex)
      const pickedIndices = exists
        ? draft.pickedIndices.filter((i) => i !== optionIndex)
        : [...draft.pickedIndices, optionIndex].sort((a, b) => a - b)
      return { ...draft, pickedIndices }
    }
    if (isCustom) return { ...draft, customSelected: true }
    return { ...draft, pickedIndices: [optionIndex], customSelected: false }
  })

  let activeStep = stepIndex
  if (!q.multiple && !isCustom && questions.length > 1) {
    const nextIdx = findNextUnansweredStep(questions, steps, stepIndex)
    if (nextIdx !== -1) activeStep = nextIdx
    else if (stepIndex < questions.length - 1) activeStep = stepIndex + 1
  }

  return { ...selection, activeStep, steps, error: "" }
}

export function updateQuestionInput(
  selection: QuestionSelection,
  stepIndex: number,
  customInput: string,
): QuestionSelection {
  const steps = selection.steps.map((draft, idx) => {
    if (idx !== stepIndex) return draft
    const shouldActivate = customInput.trim().length > 0 ? true : draft.customSelected
    return { ...draft, customInput, customSelected: shouldActivate }
  })
  return { ...selection, steps, error: "" }
}

export function answeredStepCount(
  selection: QuestionSelection,
  questions: readonly UserQuestionItem[],
): number {
  return questions.filter((q, idx) => stepAnswers(q, selection.steps[idx]).length > 0).length
}

export function canConfirmQuestion(
  selection: QuestionSelection,
  questions: readonly UserQuestionItem[],
): boolean {
  return (
    !selection.submitting &&
    questions.length > 0 &&
    answeredStepCount(selection, questions) === questions.length
  )
}

export function collectQuestionAnswers(
  selection: QuestionSelection,
  questions: readonly UserQuestionItem[],
): string[][] | undefined {
  if (!canConfirmQuestion(selection, questions)) return undefined
  return questions.map((q, idx) => stepAnswers(q, selection.steps[idx]))
}
