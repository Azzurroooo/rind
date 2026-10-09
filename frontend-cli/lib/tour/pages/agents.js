import { demoInfo } from "./demo.js";
import { agentsScene } from "./agents-demo.js";
import { agents, assistant, note, shell, shellOut, startup, submit, tool, turnDone, type } from "./steps.js";

export const agentsPages = [
  {
    id: "agents.create", feature: "← Agents", title: "Create a Team",
    steps: [
      note(["Agents Management connects existing folders as a team.", "Press Left from an empty prompt, or run rind agents. No prescribed layout or agent manifest is needed."]),
      shell("rind agents team create product"),
      shellOut(["Team product created. Add folders and select a leader."]),
      shell("rind agents team add product ~/demo"),
      shellOut(["demo joined product. The first member becomes leader."]),
      note(["The team registry lives in your RIND_HOME. Adding a folder does not move its files."]),
      shell("rind", null, "~/demo"),
      startup({ ...demoInfo({ session: "demo-team" }), management_label: "Team: product" }),
      agents(agentsScene("navigation"), "Left opens Agents. Inbox shows decisions and deliveries; Manager coordinates teams; Independent lists other conversations."),
      agents(agentsScene("created"), "Select product and press Enter. Organization lists members and their conversations; Tab switches to Tasks."),
      note(["Enter on a member lists its sessions; choose one to open chat. Esc navigates back toward the conversation you left.", "This is a simulated page: tour keys control playback, not the management service."]),
    ],
  },
  {
    id: "agents.add", feature: "Any folder", title: "Add a specialist",
    steps: [
      note(["A specialist keeps its own workspace, project skills and files. Position and responsibility are optional."]),
      shell("rind agents team add product ~/finance --position Finance --responsibility 'Reconcile invoices'"),
      shellOut(["finance joined product. Workspace: ~/finance"]),
      note(["If this folder already belongs to another team, choose an independent copy (recommended) or explicitly share it.", "Shared folders run one task at a time; each team's conversations and reports remain separate."]),
      shell("rind agents open product/finance"),
      startup({ ...demoInfo({ cwd: "~/finance", session: "demo-finance" }), management_label: "Team: product" }),
      note(["You can talk to any member directly. The team observes activity without broadcasting this private conversation."]),
    ],
  },
  {
    id: "agents.worktree", feature: "Worktrees", title: "Parallel features",
    steps: [
      note(["Different feature worktrees have different directories, so they can run in parallel."]),
      shell("rind agents team worktree product search ~/demo feature/search"),
      shellOut(["Created search and registered it in product. Branch: feature/search"]),
      shell("rind agents team worktree product export ~/demo feature/export"),
      shellOut(["Created export and registered it in product. Branch: feature/export"]),
      note(["The leader can create workspaces and worktrees within the team's creation root too.", "Only members registered in the current team can receive team tasks."]),
    ],
  },
  {
    id: "agents.tasks", feature: "Tasks & reports", title: "Assign and review work",
    steps: [
      note(["A Task is tracked work: an assignee, status and delivery report.", "Assign one to the leader from Agents; it can delegate child tasks and integrate their reports."]),
      shell("rind", null, "~/demo"),
      startup({ ...demoInfo({ session: "demo-team" }), management_label: "Team: product" }),
      agents(agentsScene(), "Select the leader and press t to assign a task. Enter the brief, then confirm the form."),
      agents(agentsScene("assign"), "Give the task an outcome and expected evidence. Enter saves; Esc cancels. This filled form is only a simulation."),
      agents(agentsScene("queued"), "The task is queued. A managed task runs in its own conversation; your original chat stays separate."),
      agents(agentsScene("delegated"), "The leader used agent_management assignTask and ended its turn. Its parent task is Delegated while the reviewer works."),
      note(["The scheduler waits after the parent's turn ends, then resumes it on child delivery.", "It does not force the model to stop: a running turn may still sleep or poll. Ordinary chat is different."]),
      agents(agentsScene("resumed"), "The reviewer delivered a report. The scheduler resumes the parent task in the same managed conversation, in a new run."),
      agents(agentsScene("delivered"), "The leader integrated the result and delivered. Tab opens Tasks; Enter on Done opens its report."),
      agents(agentsScene("report"), "Review the summary, evidence and files. Accept the delivery or request rework with feedback from the task's actions."),
      agents({ ...agentsScene("report"), reportOffset: 8 }, "In a real report, ↑↓ scrolls to evidence and files. The demo scrolled down; no file is created or opened."),
      note(["Task delivery needs a report, not just a finished process. Needs input asks for a decision.", "Unconfirmed: the old process cannot be verified. Check it stopped before retrying."]),
    ],
  },
  {
    id: "agents.sessions", feature: "Task / session", title: "Direct chat and tasks",
    steps: [
      note(["A Session is conversation history; a Task is a tracked work item.", "One member can have many sessions. Direct chat does not automatically create a task for the member."]),
      shell("rind agents open product/demo"),
      startup({ ...demoInfo({ session: "demo-direct" }), management_label: "Team: product" }),
      type("Ask reviewer to inspect Unicode handling and deliver a report."), submit(),
      tool("agent_management", "assignTask", { status: "ok", output: "Reviewer task queued. No parent task: this is direct chat.", durationMs: 120 },
        { action: "assignTask", parameters: { teamId: "product", assigneeAgentId: "reviewer", brief: "Inspect Unicode handling" } }),
      assistant("The reviewer has a tracked task. This conversation is still direct chat; open Agents to follow its delivery."),
      turnDone(2500, 1, 0),
      agents(agentsScene("direct"), "Only the assigned reviewer task appears in Tasks. The direct leader conversation has no parent task."),
      note(["Child completion does not automatically resume an ordinary direct chat. Use a managed parent task for that workflow.", "A task's session can span several runs; its report tracks delivery."]),
    ],
  },
];
