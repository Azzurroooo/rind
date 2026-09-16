import { BOARD_PAGES, demoInfo, FORK_POINTS, SESSIONS } from "./demo.js";
import { menu, note, result, shell, startup, submit, type } from "./steps.js";

export const sessionsPages = [
  {
    id: "sessions.resume",
    title: "Resume a session",
    steps: [
      note([
        "Sessions live in append-only JSONL on disk, so any machine trouble",
        "costs nothing — reopen one with its id and continue exactly there.",
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
        selected: 0,
        target: 2,
      }, [
        "Recent sessions with time, title and preview. enter switches.",
      ]),
      result("Session switched", "20260915_090412_a10f5c02"),
      note([
        "The old session stays untouched on disk — switching is free, so",
        "parallel threads of work stay one command away.",
      ]),
    ],
  },
  {
    id: "sessions.fork",
    title: "Fork at a message",
    steps: [
      note([
        "Forking branches a session at any past message: everything before the",
        "pick is kept, everything after it is left behind.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      type("/fork"),
      submit(),
      menu({
        kind: "sessions",
        input: "/fork",
        items: FORK_POINTS,
        selected: 0,
        target: 2,
      }, [
        "Pick any past message — the fork keeps the conversation up to it.",
      ]),
      result("Session forked", "20260917_110902_dd44e7f1 · history preserved to message 2"),
      note([
        "The original session stays intact. Forks are how you try a risky",
        "direction without betting the thread.",
      ]),
    ],
  },
  {
    id: "sessions.context",
    title: "Context and compact",
    steps: [
      note([
        "/context opens a live board of what the model actually sees, with",
        "measured token counts — estimates are marked with ~.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_103001_eff01a23" })),
      menu({
        kind: "board",
        input: "/context",
        pages: BOARD_PAGES,
        selected: 0,
        target: 1,
      }, [
        "Tab flips to the usage board: tokens by day, model and session.",
      ]),
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
