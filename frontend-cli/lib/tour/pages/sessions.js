import { BOARD_PAGES, demoInfo, FORK_POINTS, SESSIONS } from "./demo.js";
import { assistant, closeMenu, info, menu, note, prefill, result, shell, startup, submit, turnDone, type } from "./steps.js";

export const sessionsPages = [
  {
    id: "sessions.resume",
    feature: "rind --session",
    title: "Resume a session",
    steps: [
      note([
        "Use rind --session <id> to resume saved conversation history.",
        "Find the id in the startup banner or /status; the original workspace must still exist.",
      ]),
      shell("rind --session 20260916_181122_c88be701"),
      startup({
        ...demoInfo({ session: "20260916_181122_c88be701" }),
        resume_preview: "- user: Refactor the jsonl store to stream appends\n- assistant: Started the streaming path; index rebuild is pending.",
      }, [
        "The Recent context preview replays the last exchange before you type,",
        "so you never resume blind.",
      ]),
      type("/sessions"),
      submit(),
      menu({
        kind: "sessions",
        input: "/sessions",
        items: SESSIONS,
        selected: 1,
        target: 2,
      }, [
        "Choose a saved conversation with ↑↓. Enter switches; Esc cancels.",
      ]),
      note(["The demo selected the tour-docs session. Switching loads that session's history, not the old session's messages."]),
      closeMenu("Enter"),
      info({ session_id: "20260915_090412_a10f5c02", resume_preview: "- user: Draft the tour documentation\n- assistant: The outline is ready for review." }, true),
      result("Session switched", "20260915_090412_a10f5c02"),
      note([
        "Try /sessions between turns to switch tasks. The previous conversation remains saved.",
        "Session history is separate from project files: switching does not undo file changes.",
      ]),
    ],
  },
  {
    id: "sessions.fork",
    feature: "/fork",
    title: "Fork at a message",
    steps: [
      note([
        "Fork before a past user message to try a different request.",
        "Earlier history is copied; the selected message returns to the composer for editing.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      type("Summarize how the parser handles unicode"),
      submit(),
      assistant("The tokenizer splits on grapheme clusters, keeping combining marks with their base characters."),
      turnDone(2100, 0, 0),
      type("Now add tests for it"),
      submit(),
      assistant("I can cover emoji, combining marks and CJK in the next edit."),
      turnDone(1800, 0, 0),
      type("/fork"),
      submit(),
      menu({
        kind: "sessions",
        input: "/fork",
        items: FORK_POINTS,
        selected: 0,
        target: 1,
      }, [
        "Choose a user message, or choose the first row to keep the full history.",
      ]),
      note(["This pick keeps only the conversation before 'Now add tests for it'. That request and its reply are excluded; the request will be prefilled for editing."]),
      closeMenu("Enter"),
      info({ session_id: "20260917_110902_dd44e7f1", resume_preview: "- user: Summarize how the parser handles unicode\n- assistant: The tokenizer splits on grapheme clusters…" }, true),
      result("Session forked", "20260917_110902_dd44e7f1 · kept the first 2 of 4 messages"),
      prefill("Now add tests for it"),
      note([
        "Try /fork when you want a different approach from an earlier message.",
        "Forking copies conversation history, not your files. Use Git to preserve or revert code changes.",
      ]),
    ],
  },
  {
    id: "sessions.context",
    feature: "/context",
    title: "Context and compact",
    steps: [
      note([
        "/context opens a live board of what the model actually sees, with",
        "measured token counts — estimates are marked with ~.",
      ]),
      shell("rind --session 20260917_103001_eff01a23"),
      startup({ ...demoInfo({ session: "20260917_103001_eff01a23" }), resume_preview: "- user: Review the parser and add unicode tests\n- assistant: Tests added; the suite passes." }, ["This existing conversation has enough history to compact. A fresh empty session does not."]),
      type("/context"),
      submit(),
      menu({
        kind: "board",
        input: "/context",
        pages: BOARD_PAGES,
        selected: 0,
        target: 0,
      }, [
        "This example shows context composition. Actual values depend on your session.",
      ]),
      note(["Read the context breakdown before continuing. In Rind, Tab or ←→ switches to usage history; Esc closes the board."]),
      menu({ kind: "board", pages: BOARD_PAGES, selected: 1, target: 1 }, ["The demo pressed Tab: this is usage history by day, model and session."]),
      note(["These are sample usage figures, not your account's usage. Continue to close the board and demonstrate /compact."]),
      closeMenu(),
      type("/compact"),
      submit(),
      result("Context compacted", "handoff note kept · oldest tool results dropped"),
      note([
        "Compaction folds history into a handoff note so long projects keep",
        "their headroom without losing the plot.",
      ]),
    ],
  },
];
