import { demoInfo } from "./demo.js";
import { note, shell, shellOut, startup } from "./steps.js";

export const automationPages = [
  {
    id: "auto.run",
    title: "One-shot runs",
    steps: [
      note([
        "rind run is the same agent, headless: the final reply lands on stdout,",
        "progress on stderr — built for hooks, cron and pipelines.",
      ]),
      shell('rind run --prompt "Summarize the changes in src/" --dir /workspace/project'),
      shellOut([
        "◆ working · session 20260917_111203_5e01bb77",
        "◌ read_file src/changes.md",
        "◉ read_file src/changes.md · 180ms",
      ]),
      shellOut([
        "Two refactorings landed this week: the JSONL store now streams",
        "appends, and the parser tokenizer walks grapheme clusters.",
      ]),
      note([
        "A markdown run log with prompt, reply and tool count lands under",
        "logs/. --session <id> continues an earlier run from any script.",
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
      shellOut(["✓ delivered · steering 20260917_103001_eff01a23"]),
      note([
        "If the session is mid-turn the message steers it; if it is idle,",
        "send starts the turn. Now reopen that session to see it landed.",
      ]),
      shell("rind --session 20260917_103001_eff01a23"),
      startup({
        ...demoInfo({ session: "20260917_103001_eff01a23" }),
        resume_preview: "- user: Have the test specialist cover the unicode parser cases\n- assistant: test-specialist finished; handoff at .aiteam/agents/…\n- user (via send): Also update the README examples",
      }, [
        "The injected message is part of the transcript, marked with its",
        "origin — indistinguishable from typing it yourself.",
      ]),
      note([
        "One engine, many doors: CLI, desktop, web and IM gateways all reach",
        "the same sessions, so automation and humans share one thread.",
      ]),
    ],
  },
];
