import { demoInfo, SKILLS } from "./demo.js";
import { note, result, shell, slashResult, startup, submit, tool, type } from "./steps.js";

export const configPages = [
  {
    id: "config.init",
    title: "Project docs & skills",
    steps: [
      note([
        "RIND.md is the project's standing instructions — Rind drafts it from",
        "your codebase and injects it into context every turn.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_101530_ab12cd34" })),
      type("/init"),
      submit(),
      tool("edit_file", "RIND.md", { status: "ok", output: "drafted project doc", durationMs: 600 }),
      result("RIND.md drafted", "review and edit it — changes load next turn"),
      type("/skill list"),
      submit(),
      slashResult({
        text: "Skills",
        display: {
          type: "skills",
          skills: SKILLS,
        },
      }),
      note([
        "Skills come from .rind/skills (project) and ~/.rind/skills (user).",
        "Invoke them by name whenever a task matches.",
      ]),
    ],
  },
];
