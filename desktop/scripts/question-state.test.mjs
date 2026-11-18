import assert from "node:assert/strict"
import test from "node:test"

import {
  canConfirmQuestion,
  collectQuestionAnswers,
  createQuestionSelection,
  selectQuestionOption,
  setQuestionStep,
  updateQuestionInput,
} from "../src/renderer/question-state.ts"

const singleRecommended = [
  {
    header: "Depth",
    question: "How thorough should analysis be?",
    options: [
      { label: "Fast (Recommended)", description: "Use less analysis." },
      { label: "Thorough", description: "Use more analysis." },
    ],
  },
]

test("question selection pre-selects a Recommended first option, otherwise starts unselected", () => {
  const recSelection = createQuestionSelection("q-1", singleRecommended)
  assert.deepEqual(recSelection.steps[0].pickedIndices, [0])
  assert.equal(canConfirmQuestion(recSelection, singleRecommended), true)
  assert.deepEqual(collectQuestionAnswers(recSelection, singleRecommended), [["Fast (Recommended)"]])

  const neutral = [
    {
      question: "Pick a theme",
      options: [
        { label: "Light", description: "Daytime" },
        { label: "Dark", description: "Nighttime" },
      ],
    },
  ]
  const neutralSel = createQuestionSelection("q-2", neutral)
  assert.deepEqual(neutralSel.steps[0].pickedIndices, [])
  assert.equal(canConfirmQuestion(neutralSel, neutral), false)
})

test("open-ended question stays unconfirmed until custom input is entered", () => {
  const openQ = [{ question: "Name the target branch", options: null }]
  const selection = createQuestionSelection("q-open", openQ)

  assert.equal(selection.steps[0].customSelected, true)
  assert.equal(canConfirmQuestion(selection, openQ), false)
  assert.equal(collectQuestionAnswers(selection, openQ), undefined)

  const typed = updateQuestionInput(selection, 0, "feat/multi-question")
  assert.equal(canConfirmQuestion(typed, openQ), true)
  assert.deepEqual(collectQuestionAnswers(typed, openQ), [["feat/multi-question"]])
})

test("multi-question deck auto-advances on single-select, supports multi-select, and retains custom drafts", () => {
  const multi = [
    {
      header: "Storage",
      question: "Which DB?",
      options: [
        { label: "SQLite", description: "Embedded" },
        { label: "Postgres", description: "Server" },
      ],
    },
    {
      header: "Surfaces",
      question: "Which surfaces?",
      multiple: true,
      options: [
        { label: "CLI", description: "Terminal" },
        { label: "Desktop", description: "Electron" },
      ],
    },
  ]
  let sel = createQuestionSelection("q-m", multi)
  assert.equal(sel.activeStep, 0)

  // Draft custom text on step 0, then pick preset option 1 -> auto-advances to step 1 while retaining draft
  sel = selectQuestionOption(sel, 0, 2, multi)
  sel = updateQuestionInput(sel, 0, "temporary draft")
  sel = selectQuestionOption(sel, 0, 1, multi)
  assert.equal(sel.activeStep, 1)
  assert.equal(sel.steps[0].customInput, "temporary draft")

  // Toggle both checkboxes on step 1 plus custom input
  sel = selectQuestionOption(sel, 1, 0, multi)
  sel = selectQuestionOption(sel, 1, 1, multi)
  sel = updateQuestionInput(sel, 1, "Mobile")
  assert.equal(canConfirmQuestion(sel, multi), true)
  assert.deepEqual(collectQuestionAnswers(sel, multi), [
    ["Postgres"],
    ["CLI", "Desktop", "Mobile"],
  ])

  sel = setQuestionStep(sel, 0)
  assert.equal(sel.activeStep, 0)
})
