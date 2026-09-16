import { demoInfo, TEST_TASK } from "./demo.js";
import {
  assistant,
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
        "Welcome to Rind. This tour plays inside a simulated terminal — every",
        "screen is drawn by Rind's own renderer, so it looks exactly like this.",
      ]),
      shell("rind"),
      startup(ROOT, [
        "The banner confirms model, session and workspace before you type",
        "anything. Nothing is sent anywhere until you submit a prompt.",
      ]),
      type("Summarize how the parser handles unicode, then add tests for it."),
      note([
        "This is the composer — the only input you need. Type, press enter,",
        "and Rind runs the turn.",
      ]),
      submit(),
      tool("read_file", "src/parser/tokenizer.js", { status: "ok", output: "read 214 lines", durationMs: 320 }),
      tool("read_file", "test/tokenizer.test.js", { status: "ok", output: "read 96 lines", durationMs: 210 }),
      note([
        "Tools appear as live blocks while Rind works. ctrl+o expands or",
        "collapses their output everywhere at once.",
      ]),
      assistant([
        "The tokenizer walks the input by grapheme clusters, so emoji and CJK",
        "count as single characters:",
        "",
        "| Input | Code points | Graphemes |",
        "| --- | --- | --- |",
        "| a😀b | 4 | 3 |",
        "| 中文 | 2 | 2 |",
        "",
        "Added three cases to `test/tokenizer.test.js` covering emoji,",
        "combining marks and wide CJK.",
      ].join("\n")),
      turnDone(18400, 3, 0),
      note([
        "A full turn: prompt, tool work, streamed reply, summary line.",
        "Next: steering a turn while it runs.",
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
      type("Refactor the session store to stream appends"),
      submit(),
      type("Keep the old index file working"),
      submit("queue"),
      note([
        "Tab parked that as a queued follow-up. alt+up recalls it into the",
        "composer; alt+right promotes it to steering when it cannot wait.",
      ]),
      type("Stop — the streaming path matters more, do that first"),
      submit("steer"),
      note([
        "Enter during a turn steers immediately: the composer shows it as",
        "Steering and the agent sees it without waiting for the turn to end.",
      ]),
      assistant([
        "Paused the index work. Streaming appends first: each JSONL line now",
        "flushes as it is written, and the old index rebuilds lazily on open.",
        "I'll pick the queued index compatibility task back up right after.",
      ]),
      turnDone(22600, 2, 0),
      note([
        "Both inputs survived one turn: the steer re-ordered work, the queue",
        "held its place until the turn completed.",
      ]),
    ],
  },
  {
    id: "start.monitor",
    title: "Background monitor",
    steps: [
      note([
        "Long commands go to the background instead of blocking the turn.",
        "ctrl+b opens a live monitor for background tasks and delegates.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_104512_31cc09de" })),
      type("Run the whole test suite, then audit production dependencies"),
      submit(),
      menu({
        kind: "monitor",
        tasks: [TEST_TASK],
        task: TEST_TASK,
      }, [
        "The monitor streams task output live, under the composer, while the",
        "turn keeps working. ←→ switch between Background and Delegates.",
      ]),
      note([
        "esc closes the monitor; the agent keeps working either way.",
        "Watch the bash task finish below.",
      ]),
      tool("bash", "npm test", { status: "ok", output: "312 passing", durationMs: 9600 }),
      turnDone(21400, 2, 0),
      note([
        "Background work never blocks the conversation — check on it whenever",
        "you like with ctrl+b.",
      ]),
    ],
  },
];
