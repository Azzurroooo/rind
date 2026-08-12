import { renderMark } from "./logo.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ACCENT = "\x1b[38;5;81m";

const mark = renderMark(26).split("\n");
const side = [
  `${BOLD}Rind${RESET} ${DIM}workbench online${RESET}`,
  `${DIM}glm-5.1 · E:\\code\\agent1\\rind${RESET}`,
];

const rows = Math.max(mark.length, side.length);
for (let i = 0; i < rows; i += 1) {
  const m = (mark[i] ?? "").padEnd(54, " ");
  const t = side[i] ?? "";
  process.stdout.write(`${m}${t}\n`);
}

process.stdout.write(`${DIM}${"─".repeat(58)}${RESET}\n`);
process.stdout.write(`${ACCENT}›${RESET} ${DIM}Ask Rind to do anything${RESET}\n`);
