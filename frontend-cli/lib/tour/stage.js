import { graphemes } from "../text-width.js";

// Pure presentation state machine for a tour page. Steps go in as plain data;
// snapshot() comes out as plain data, so any settled step index can be replayed
// deterministically via rebuildTo() and compared with the animated path.
export function createTourStage() {
  let shell = { blocks: [], typing: null };
  let rind = null;
  let caption = null;
  let active = null;

  function emptyComposer() {
    return { text: "", running: false, hidden: false, pending: [], menu: null };
  }

  function ensureRind() {
    if (!rind) {
      rind = { info: {}, blocks: [], composer: emptyComposer() };
    }
    return rind;
  }

  function lastBlock(kind) {
    const block = rind?.blocks.at(-1);
    return block && block.kind === kind ? block : null;
  }

  function reset() {
    shell = { blocks: [], typing: null };
    rind = null;
    caption = null;
    active = null;
  }

  function beginStep(step) {
    active = step;
    if (step.note) {
      caption = step.note;
    }
    switch (step.kind) {
      case "shell":
        shell.typing = { command: step.command, revealed: 0 };
        break;
      case "shell-out":
        shell.typing = null;
        shell.blocks.push({ kind: "output", lines: step.lines, shown: 0 });
        break;
      case "startup":
        rind = { info: step.info, blocks: [], composer: emptyComposer() };
        break;
      case "type": {
        const composer = ensureRind().composer;
        composer.hidden = false;
        composer.text = "";
        break;
      }
      case "result": {
        const composer = ensureRind().composer;
        composer.menu = null;
        rind.blocks.push({ kind: "result", text: step.text, detail: step.detail, display: step.display || null });
        break;
      }
      case "tool":
        ensureRind().blocks.push({ kind: "tool", name: step.name, detail: step.detail, outcome: step.outcome, running: true });
        break;
      case "assistant":
        ensureRind().blocks.push({ kind: "assistant", text: step.text, reveal: 0 });
        break;
      case "turn-done":
        ensureRind().blocks.push({
          kind: "turn-done",
          durationMs: step.durationMs,
          completed: step.completed,
          failed: step.failed,
        });
        break;
      case "menu": {
        const composer = ensureRind().composer;
        composer.hidden = false;
        composer.menu = { ...step.menu };
        break;
      }
      case "submit":
      case "turn-done":
      case "exit":
        break;
      case "note":
        caption = step.lines;
        break;
    }
  }

  // Advances the active step's reveal cursor by one unit; returns true when
  // more units remain in the step.
  function tick() {
    switch (active?.kind) {
      case "shell": {
        const typing = shell.typing;
        if (!typing) return false;
        const total = graphemes(typing.command).length;
        typing.revealed = Math.min(total, typing.revealed + 1);
        return typing.revealed < total;
      }
      case "shell-out": {
        const block = shell.blocks.at(-1);
        if (!block || block.kind !== "output") return false;
        block.shown = Math.min(block.lines.length, block.shown + 1);
        return block.shown < block.lines.length;
      }
      case "type": {
        const composer = ensureRind().composer;
        const chars = graphemes(active.text);
        const shown = Math.min(chars.length, graphemes(composer.text).length + 1);
        composer.text = chars.slice(0, shown).join("");
        return shown < chars.length;
      }
      case "assistant": {
        const block = lastBlock("assistant");
        if (!block) return false;
        const total = block.text.split("\n").length;
        block.reveal = Math.min(total, block.reveal + 1);
        return block.reveal < total;
      }
      case "menu": {
        const menu = rind?.composer.menu;
        if (!menu || typeof menu.target !== "number") return false;
        menu.selected = Math.min(menu.target, (Number(menu.selected) || 0) + 1);
        return menu.selected < menu.target;
      }
      default:
        return false;
    }
  }

  function settleStep(step) {
    switch (step.kind) {
      case "shell": {
        const typing = shell.typing;
        shell.typing = null;
        if (typing) {
          shell.blocks.push({ kind: "command", command: typing.command });
        }
        break;
      }
      case "shell-out": {
        const block = shell.blocks.at(-1);
        if (block && block.kind === "output") {
          block.shown = block.lines.length;
        }
        break;
      }
      case "type":
        ensureRind().composer.text = step.text;
        break;
      case "submit": {
        const composer = ensureRind().composer;
        composer.menu = null;
        const mode = step.mode || "send";
        if (mode === "send") {
          rind.blocks.push({ kind: "user", text: composer.text });
          composer.running = true;
        } else {
          composer.pending.push({ mode: mode === "queue" ? "follow_up" : "steering", input: composer.text });
        }
        composer.text = "";
        break;
      }
      case "tool": {
        const block = lastBlock("tool");
        if (block) {
          block.running = false;
        }
        break;
      }
      case "assistant": {
        const block = lastBlock("assistant");
        if (block) {
          block.reveal = block.text.split("\n").length;
        }
        break;
      }
      case "menu": {
        const menu = rind?.composer.menu;
        if (menu && typeof menu.target === "number") {
          menu.selected = menu.target;
        }
        break;
      }
      case "turn-done": {
        const composer = ensureRind().composer;
        composer.running = false;
        composer.pending = [];
        composer.menu = null;
        break;
      }
      case "exit": {
        const composer = ensureRind().composer;
        composer.menu = null;
        composer.hidden = true;
        composer.running = false;
        composer.pending = [];
        composer.text = "";
        rind.blocks.push({ kind: "goodbye" });
        break;
      }
      case "result":
      case "startup":
      case "note":
        break;
    }
    active = null;
  }

  function rebuildTo(steps, index) {
    reset();
    for (let position = 0; position <= index && position < steps.length; position += 1) {
      beginStep(steps[position]);
      settleStep(steps[position]);
    }
  }

  function snapshot() {
    return {
      shell: {
        blocks: shell.blocks.map((block) => ({ ...block })),
        typing: shell.typing ? { ...shell.typing } : null,
      },
      rind: rind ? {
        info: rind.info,
        blocks: rind.blocks.map((block) => ({ ...block })),
        composer: {
          ...rind.composer,
          pending: rind.composer.pending.map((entry) => ({ ...entry })),
          menu: rind.composer.menu ? { ...rind.composer.menu } : null,
        },
      } : null,
      caption: caption ? [...caption] : null,
    };
  }

  return { reset, beginStep, settleStep, tick, rebuildTo, snapshot };
}
