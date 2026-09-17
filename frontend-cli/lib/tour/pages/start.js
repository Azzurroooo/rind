import { demoInfo, TEST_TASK } from "./demo.js";
import {
  assistant,
  closeMenu,
  consume,
  expandTools,
  menu,
  note,
  shell,
  shellOut,
  startup,
  submit,
  tool,
  turnDone,
  type,
} from "./steps.js";

const ROOT = demoInfo({ session: "20260917_101530_ab12cd34" });

export const startPages = [
  {
    id: "start.hello",
    title: "Your first turn",
    steps: [
      note([
        "Watch a simulated Rind session. Nothing here runs commands or calls a model.",
        "Space starts or pauses playback; ? shows tour controls. Try the examples after leaving the tour.",
      ]),
      shell("rind"),
      startup(ROOT, [
        "The banner confirms model, session and workspace before you type",
        "anything. Start rind from the project directory you want to work in.",
      ]),
      type("Summarize how the parser handles unicode, then add tests for it."),
      note([
        "In a real session, type a task here and press Enter to send it.",
        "For this demo, press Space to watch Rind read, edit and test the code.",
      ]),
      submit(),
      tool("read_file", "src/parser/tokenizer.js", { status: "ok", output: 'const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });\nexport const tokenize = (text) => [...segmenter.segment(text)];', durationMs: 320 }),
      tool("read_file", "test/tokenizer.test.js", { status: "ok", output: 'test("ASCII", () => assert.equal(tokenize("abc").length, 3));', durationMs: 210 }),
      expandTools(),
      note([
        "The demo pressed Ctrl+O to expand tool output. In Rind, use it to inspect",
        "what was read or changed; press it again to collapse the output.",
      ]),
      expandTools(false),
      tool("edit_file", "test/tokenizer.test.js", { status: "ok", output: "Added emoji, combining-mark and CJK tests", durationMs: 400,
        fileChange: { lines: [
          { kind: "added", text: 'test("emoji", () => assert.equal(tokenize("a😀b").length, 3));' },
          { kind: "added", text: 'test("combining", () => assert.equal(tokenize("é").length, 1));' },
          { kind: "added", text: 'test("CJK", () => assert.equal(tokenize("中文").length, 2));' },
        ] },
      }),
      tool("bash", "npm test", { status: "ok", output: "4 tests passed", durationMs: 820 }),
      assistant([
        "The tokenizer walks the input by grapheme clusters, so emoji and CJK",
        "count as single characters:",
        "",
        "| Input | Code points | Graphemes |",
        "| --- | --- | --- |",
        "| a😀b | 3 | 3 |",
        "| é | 2 | 1 |",
        "| 中文 | 2 | 2 |",
        "",
        "Added three cases to `test/tokenizer.test.js` covering emoji,",
        "combining marks and wide CJK.",
      ].join("\n")),
      turnDone(18400, 4, 0),
      note([
        "Try it: exit this tour and ask Rind to explain a file in your project.",
        "Review proposed edits and test results. Ctrl+C interrupts a running turn; /exit leaves Rind.",
      ]),
    ],
  },
  {
    id: "start.steer",
    title: "Steer and queue",
    steps: [
      note([
        "A running turn never locks the composer. Enter sends text as steering,",
        "tab parks it as a queued follow-up for after the turn.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_102212_77aa01bc" })),
      type("Plan how to refactor the session store to stream appends"),
      submit(),
      type("Then check whether the existing index tests pass"),
      submit("queue"),
      note([
        "The demo used Tab to queue a separate turn. It will run after this one.",
        "In Rind, Alt+↑/↓ recalls pending input; Alt+→ promotes a follow-up to steering.",
      ]),
      type("Focus on the streaming path first; keep the plan brief"),
      submit("steer"),
      note([
        "Enter during a turn adds steering for the next opportunity to process it.",
        "It does not cancel an already running command; Ctrl+C interrupts the turn.",
      ]),
      consume("steering"),
      assistant([
        "Start with the append path: write one JSONL record at a time, flush",
        "before acknowledging it, and rebuild the old index on open.",
        "The queued test check runs as a separate turn next.",
      ]),
      turnDone(4200, 0, 0),
      note([
        "The first turn is done. The follow-up is still queued below.",
        "Continue to watch it become the next user message automatically.",
      ]),
      consume("follow_up"),
      tool("bash", "npm test", { status: "ok", output: "Index compatibility: 12 tests passed", durationMs: 1800 }),
      assistant("All 12 existing index tests pass. No files were changed."),
      turnDone(2500, 1, 0),
      note(["Try it: Enter adjusts the current task; Tab schedules another task. Watch pending input move into the transcript when it is consumed."]),
    ],
  },
  {
    id: "start.monitor",
    title: "Background monitor",
    steps: [
      note([
        "Commands that outlast their wait limit can continue in the background.",
        "ctrl+b opens a live monitor for background tasks and delegates.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_104512_31cc09de" })),
      type("Run the whole test suite, then audit production dependencies"),
      submit(),
      tool("bash", "npm test", { status: "ok", output: "", durationMs: 1000, data: { status: "running", bg_id: "bg-1", stdout: "Tests started" } }),
      menu({
        kind: "monitor",
        tasks: [TEST_TASK],
        task: TEST_TASK,
      }, [
        "The monitor streams task output live, under the composer, while the",
        "turn keeps working. ←→ switch between Background and Delegates.",
      ]),
      note([
        "In Rind, Esc closes this monitor without stopping the command.",
        "The demo will close it and collect the finished task's output.",
      ]),
      closeMenu(),
      tool("bash_output", "bg-1", { status: "ok", output: "312 tests passed", durationMs: 9600 }),
      assistant("All 312 tests passed. I can now audit the production dependencies."),
      turnDone(21400, 2, 0),
      note([
        "Try Ctrl+B during a real task. Use ←→ for Background/Delegates and ↑↓ to select a task.",
        "Closing the monitor only hides it; it does not stop background work.",
      ]),
    ],
  },
];
