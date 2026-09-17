import { note, shell, shellOut } from "./steps.js";

export const automationPages = [
  {
    id: "auto.run",
    title: "One-shot runs",
    steps: [
      note([
        "rind run is the same agent, headless: the final reply lands on stdout,",
        "progress on stderr — built for hooks, cron and pipelines.",
      ]),
      shell('rind run --prompt "Summarize the changes in src/" --dir /workspace/project 2>progress.log', ["This example redirects stderr to progress.log; only the final answer appears in the terminal. Replace /workspace/project with your own absolute path."]),
      shellOut([
        "Two refactorings landed this week: the JSONL store now streams",
        "appends, and the parser tokenizer walks grapheme clusters.",
      ]),
      note([
        "Check progress.log for progress and errors, and logs/ in the workspace for the markdown run log.",
        "Try rind run --prompt with a small task; use --session <id> to continue a saved session.",
      ]),
    ],
  },
  {
    id: "auto.send",
    title: "Inject into a session",
    steps: [
      note([
        "rind send delivers a prompt into a running session from any terminal",
        "or script — the session id is the address.",
      ]),
      shell('rind send --session 20260917_103001_eff01a23 "Also update the README examples"'),
      shellOut(["✓ sent to rind · session 20260917_103001_eff01a23"]),
      note([
        "If the session is mid-turn the message steers it; if it is idle,",
        "send starts the turn. Read the reply in the already-open target session.",
      ]),
      note([
        "Try it from a second terminal while the target CLI session is still open on this machine.",
        "Copy its id from /status. The confirmation means delivered, not finished; a closed session cannot receive rind send.",
      ]),
    ],
  },
];
