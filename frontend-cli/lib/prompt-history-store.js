import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HISTORY_LIMIT = 100;

export function promptHistoryPath(rindHome = process.env.RIND_HOME || path.join(homedir(), ".rind")) {
  return path.join(String(rindHome), "cli-history.jsonl");
}

export function loadPromptHistory(rindHome) {
  try {
    const lines = readFileSync(promptHistoryPath(rindHome), "utf8").split(/\r?\n/);
    const history = [];
    for (let index = lines.length - 1; index >= 0 && history.length < HISTORY_LIMIT; index -= 1) {
      try {
        const value = JSON.parse(lines[index]);
        const text = typeof value === "string" ? value.trim() : "";
        if (text && !history.includes(text)) {
          history.push(text);
        }
      } catch {
        continue;
      }
    }
    return history;
  } catch {
    return [];
  }
}

export function savePromptHistory(history, rindHome) {
  const values = [];
  for (const value of Array.isArray(history) ? history : []) {
    const text = String(value || "").trim();
    if (!text || values.includes(text)) {
      continue;
    }
    values.push(text);
    if (values.length >= HISTORY_LIMIT) {
      break;
    }
  }
  const file = promptHistoryPath(rindHome);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${values.reverse().map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
