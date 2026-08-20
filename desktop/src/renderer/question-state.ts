export type QuestionChoice = {
  label: string
  description: string
}

export type QuestionSelection = {
  questionId: string
  selectedIndex: number
  customInput: string
}

export function createQuestionSelection(questionId: string, optionCount: number): QuestionSelection {
  const count = Math.max(0, Math.floor(optionCount))
  return {
    questionId,
    selectedIndex: count > 0 ? 0 : -1,
    customInput: "",
  }
}

export function selectQuestionOption(
  selection: QuestionSelection,
  selectedIndex: number,
  optionCount: number,
): QuestionSelection {
  const customIndex = Math.max(0, Math.floor(optionCount))
  const nextIndex = Math.max(-1, Math.min(customIndex, Math.floor(selectedIndex)))
  return {
    ...selection,
    selectedIndex: nextIndex,
    customInput: nextIndex === customIndex ? selection.customInput : "",
  }
}

export function updateQuestionInput(selection: QuestionSelection, customInput: string): QuestionSelection {
  return { ...selection, customInput }
}

export function canConfirmQuestion(selection: QuestionSelection, optionCount: number): boolean {
  const customIndex = Math.max(0, Math.floor(optionCount))
  return selection.selectedIndex >= 0
    && (selection.selectedIndex < customIndex || Boolean(selection.customInput.trim()))
}

export function questionAnswer(
  selection: QuestionSelection,
  options: QuestionChoice[],
): string | undefined {
  if (selection.selectedIndex >= 0 && selection.selectedIndex < options.length) {
    return options[selection.selectedIndex]?.label
  }
  const customInput = selection.customInput.trim()
  return customInput || undefined
}
