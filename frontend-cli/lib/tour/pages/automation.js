import { demoInfo, REMOTE_ITEMS_OFF, REMOTE_ITEMS_ON } from "./demo.js";
import { closeMenu, info, menu, note, shell, shellOut, slashResult, startup, submit, type } from "./steps.js";

export const automationPages = [
  {
    id: "auto.run",
    feature: "rind run",
    title: "One-shot runs",
    steps: [
      note([
        "rind run is the same agent, headless: the final reply lands on stdout,",
        "progress on stderr — built for hooks, cron and pipelines.",
      ]),
      shell('rind run --prompt "Summarize the changes in src/" --dir /workspace/project 2>progress.log', [
        "Redirect stderr (2>progress.log) so only the clean final answer is printed to stdout.",
      ]),
      shellOut([
        "Two refactorings landed this week: the JSONL store now streams",
        "appends, and the parser tokenizer walks grapheme clusters.",
      ], [
        "The final reply streams to stdout ready for pipes or CI scripts, while tool progress is logged to progress.log.",
      ]),
      note([
        "Check progress.log for progress and errors. Session history is saved separately from the final stdout reply.",
        "Try rind run --prompt with a small task; use --session <id> to continue a saved session.",
      ]),
    ],
  },
  {
    id: "auto.send",
    feature: "rind send",
    title: "Inject into a session",
    steps: [
      note([
        "rind send delivers a prompt into a running session from any terminal",
        "or script — the session id is the address.",
      ]),
      shell('rind send --session 20260917_103001_eff01a23 "Also update the README examples"', [
        "Target an open session by its id (shown in the startup banner and /status).",
      ]),
      shellOut([
        "✓ sent to rind · session 20260917_103001_eff01a23",
      ], [
        "If the target session is mid-turn, the message steers it; if it is idle, send starts a new turn.",
      ]),
      note([
        "The confirmation means delivered, not finished — read the reply in the target session.",
        "For a closed idle session, resume with rind --session <id> or rind run --session <id>.",
      ]),
    ],
  },
  {
    id: "auto.remote",
    feature: "/remote",
    title: "Remote web & mobile",
    steps: [
      note([
        "/remote opens a local or LAN web interface with a pairing QR code",
        "and rotatable access code so you can monitor or steer from your phone.",
      ]),
      shell("rind"),
      startup(demoInfo({ session: "20260917_110200_44bc88ef" })),
      type("/remote", [
        "Run /remote in an interactive session to open the Remote access menu.",
      ]),
      submit(),
      menu({
        kind: "remote",
        input: "/remote",
        items: REMOTE_ITEMS_OFF,
        selected: 0,
        target: 0,
      }, [
        "Press Space or Enter to turn on Remote access, or choose Network scope (Local network vs This computer).",
        "Turning on Remote access starts the embedded web server and shows a pairing QR code and sign-in link.",
      ]),
      note([
        "Press Space or Enter to turn on Remote access, or choose Network scope (Local network vs This computer).",
        "Turning on Remote access starts the embedded web server and shows a pairing QR code and sign-in link.",
      ]),
      menu({
        kind: "remote",
        input: "/remote",
        items: REMOTE_ITEMS_ON,
        selected: 0,
        target: 3,
      }, [
        "Once active, the menu shows connected devices, the pairing QR link, network scope, and Rotate access code to revoke old sessions.",
      ]),
      closeMenu("Esc"),
      info({ remote_running: true }),
      slashResult({ text: "Remote access enabled · Local network · http://192.168.1.24:8766" }, [
        "While remote access is on, the composer header displays the ⚯ indicator next to your workspace path.",
      ]),
      note([
        "Try /remote to pair a phone or browser on your Wi-Fi network, or restrict scope to 127.0.0.1 for local browser use.",
        "Rotate the access code or turn Remote access off from /remote at any time.",
      ]),
    ],
  },
];
