import assert from "node:assert/strict"
import test from "node:test"

import {
  canConfirmQuestion,
  createQuestionSelection,
  questionAnswer,
  selectQuestionOption,
  updateQuestionInput,
} from "../src/renderer/question-state.ts"

const options = [
  { label: "Fast (Recommended)", description: "Use less analysis." },
  { label: "Thorough", description: "Use more analysis." },
]

test("question selection defaults to the first option", () => {
  const selection = createQuestionSelection("question-1", options.length)

  assert.equal(selection.selectedIndex, 0)
  assert.equal(canConfirmQuestion(selection, options.length), true)
  assert.equal(questionAnswer(selection, options), "Fast (Recommended)")
})

test("question selection stays unconfirmed until custom input is entered", () => {
  const selection = createQuestionSelection("question-1", 0)

  assert.equal(selection.selectedIndex, -1)
  assert.equal(canConfirmQuestion(selection, 0), false)
  assert.equal(questionAnswer(selection, []), undefined)

  const custom = selectQuestionOption(selection, 0, 0)
  assert.equal(custom.selectedIndex, 0)
  assert.equal(canConfirmQuestion(custom, 0), false)
  assert.equal(canConfirmQuestion(updateQuestionInput(custom, "custom answer"), 0), true)
})

test("leaving the custom option discards its draft", () => {
  const selected = selectQuestionOption(createQuestionSelection("question-1", options.length), options.length, options.length)
  const drafted = updateQuestionInput(selected, "temporary answer")
  const switched = selectQuestionOption(drafted, 1, options.length)

  assert.equal(switched.selectedIndex, 1)
  assert.equal(switched.customInput, "")
  assert.equal(questionAnswer(switched, options), "Thorough")
})
