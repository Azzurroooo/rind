import { demoInfo, DELEGATES } from "./demo.js";
import {
  assistant,
  closeMenu,
  exitRind,
  menu,
  note,
  shell,
  shellOut,
  slashResult,
  startup,
  submit,
  tool,
  turnDone,
  turnStart,
  type,
} from "./steps.js";

const PROJECT = demoInfo({ session: "20260917_101530_ab12cd34" });
const MAIN = demoInfo({ cwd: "~/demo/.aiteam/agents/main-agent", session: "20260917_103001_eff01a23" });

function enterMainAgent() {
  return [
    shell("cd .aiteam/agents/main-agent"),
    shell("rind", null, "~/demo/.aiteam/agents/main-agent"),
    startup(MAIN, [
      "Starting rind inside an agent directory makes this session that agent:",
      "delegation and /team commands operate on the team project.",
    ]),
  ];
}

export const teamPages = [
  {
    id: "team.create",
    title: "Create a Team",
    steps: [
      note([
        "A Rind Team is filesystem-native: every specialist is a directory with",
        "its own workspace, tools and persistent history under .aiteam/.",
      ]),
      shell("rind"),
      startup(PROJECT, [
        "Teams start in the project root — a regular session does the creating.",
      ]),
      type("/team create"),
      submit(),
      slashResult({ text: "Team project created: demo\nMain agent: main-agent\nWorkspace: ~/demo/.aiteam/agents/main-agent" }),
      type("/exit"),
      exitRind(),
      shell("ls .aiteam/agents"),
      shellOut(["main-agent"]),
      ...enterMainAgent(),
      note([
        "That is the whole loop: create once, then work from the main agent.",
        "Next pages add specialists, blueprints and delegation.",
      ]),
    ],
  },
  {
    id: "team.add",
    title: "Add a specialist",
    steps: [
      note([
        "First create a team with /team create in the project root (see Create a Team).",
        "Then start Rind in .aiteam/agents/main-agent to add a specialist.",
      ]),
      ...enterMainAgent(),
      type('/team add "Owns the test suite and CI wiring"'),
      submit(),
      slashResult({ text: "Preparing a Team Agent for: Owns the test suite and CI wiring" }),
      turnStart("Create a Team Agent for this responsibility: Owns the test suite and CI wiring"),
      tool("agent_create", "test-specialist", { status: "ok", output: "capsule created", durationMs: 900 }),
      assistant("Created test-specialist to own the test suite and CI wiring."),
      turnDone(3400, 1, 0),
      type("/team list"),
      submit(),
      slashResult({
        text: [
          "Team Agents:",
          "- main-agent | Main | Coordinates the project",
          "- test-specialist | Test Specialist | Owns the test suite and CI wiring",
        ].join("\n"),
      }),
      note([
        "The capsule directory keeps the agent's history and files, so next",
        "week's task starts from everything it already knows.",
      ]),
    ],
  },
  {
    id: "team.blueprint",
    title: "Create from blueprint",
    steps: [
      note([
        "Blueprints are local specialist templates in ~/.rind/blueprints (or RIND_HOME/blueprints).",
        "This demo assumes a team and two installed templates; an empty installation has no blueprints.",
      ]),
      ...enterMainAgent(),
      type("/team blueprint"),
      submit(),
      slashResult({
        text: [
          "Available blueprints:",
          "- reviewer | Code Reviewer | Reviews diffs against the project rules",
          "- documenter | Documenter | Keeps README and RIND.md current",
        ].join("\n"),
      }),
      menu({
        kind: "choice",
        input: "/team blueprint",
        items: [
          "reviewer · Code Reviewer · Reviews diffs against the project rules",
          "documenter · Documenter · Keeps README and RIND.md current",
        ],
        selected: 0,
        target: 1,
      }, [
        "In Rind, ↑↓ selects an installed template and Enter creates that agent.",
      ]),
      note(["The demo selected Documenter. If your list is empty, use /team add <description> to create a specialist without a blueprint."]),
      closeMenu("Enter"),
      slashResult({ text: "Team Agent created: documenter\nWorkspace: ~/demo/.aiteam/agents/documenter" }),
      note([
        "The new agent is ready for delegation immediately, with the",
        "blueprint's tool policy and prompt baked into its capsule.",
      ]),
    ],
  },
  {
    id: "team.work",
    title: "Work inside the team",
    steps: [
      note([
        "This example needs the team and test-specialist from the previous pages.",
        "Ask the main agent to delegate a specific task with an expected output.",
      ]),
      ...enterMainAgent(),
      type("Have the test specialist cover the unicode parser cases"),
      submit(),
      menu({
        kind: "delegates",
        delegates: DELEGATES,
        delegate: DELEGATES[0],
      }, [
        "ctrl+b shows running delegates too — watch progress without",
        "interrupting anyone.",
      ]),
      note(["The demo opened Ctrl+B and switched to Delegates with →. In Rind, Esc closes this view while delegation continues."]),
      closeMenu(),
      tool("delegate", "test-specialist", { status: "ok", output: "6 cases added to test/tokenizer.test.js", durationMs: 12400 }),
      assistant([
        "test-specialist finished: the unicode cases live in",
        "`test/tokenizer.test.js`, and the handoff summary is published at",
        "`.aiteam/agents/test-specialist/handoffs/unicode.md`.",
      ]),
      turnDone(24800, 1, 0),
      note([
        "Try a small task. Ask for output paths and review the files afterward.",
        "An agent's workspace and permissions determine where it writes; these paths are examples.",
      ]),
    ],
  },
];
