import { graphemes } from "../text-width.js";

// Pure presentation state machine for a tour page. Steps go in as plain data;
// snapshot() comes out as plain data, so any settled step index can be replayed
// deterministically via rebuildTo() and compared with the animated path.
export function createTourStage({ version } = {}) {
  let shell = { blocks: [], typing: null };
  let rind = null;
  let caption = null;
  let active = null;
  let history = [];
  let expanded = false;

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
    history = [];
    expanded = false;
  }

  function beginStep(step) {
    active = step;
    if (step.note) {
      caption = step.note;
    }
    switch (step.kind) {
      case "shell":
        if (rind?.composer.hidden) {
          history.push({ shell, rind });
          shell = { blocks: [], typing: null };
          rind = null;
        }
        shell.typing = { command: step.command, revealed: 0, ...(step.cwd ? { cwd: step.cwd } : {}) };
        break;
      case "shell-out":
        shell.typing = null;
        shell.blocks.push({ kind: "output", lines: step.lines, shown: 0 });
        break;
      case "startup":
        rind = { info: { ...step.info, ...(version ? { version } : {}) }, blocks: [], composer: emptyComposer() };
        break;
      case "type": {
        const composer = ensureRind().composer;
        composer.hidden = false;
        composer.text = "";
        break;
      }
      case "result":
      case "slash-result": {
        const composer = ensureRind().composer;
        composer.menu = null;
        rind.blocks.push({
          kind: step.kind,
          text: step.text,
          detail: step.detail,
          display: step.display || null,
        });
        break;
      }
      case "tool":
        ensureRind().blocks.push({ kind: "tool", name: step.name, detail: step.detail, outcome: step.outcome, running: true });
        break;
      case "assistant":
        ensureRind().blocks.push({ kind: "assistant", text: step.text, reveal: 0, complete: false });
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
        if (step.menu.kind === "auth-secret") composer.menu.value = "";
        break;
      }
      case "submit":
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
        const total = graphemes(block.text).length;
        block.reveal = Math.min(total, block.reveal + 3);
        return block.reveal < total;
      }
      case "menu": {
        const menu = rind?.composer.menu;
        if (menu?.kind === "auth-secret") {
          const chars = graphemes(active.menu.value || "");
          const shown = Math.min(chars.length, graphemes(menu.value).length + 1);
          menu.value = chars.slice(0, shown).join("");
          return shown < chars.length;
        }
        if (!menu || typeof menu.target !== "number") return false;
        const current = Number(menu.selected) || 0;
        if (current === menu.target) return false;
        menu.selected = current < menu.target ? current + 1 : current - 1;
        return menu.selected !== menu.target;
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
          shell.blocks.push({ kind: "command", command: typing.command, ...(typing.cwd ? { cwd: typing.cwd } : {}) });
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
      case "prefill":
        ensureRind().composer.text = step.text;
        break;
      case "submit": {
        const composer = ensureRind().composer;
        composer.menu = null;
        const mode = step.mode || "send";
        if (mode === "send") {
          // Slash commands never start a turn in the real dispatch; only a
          // plain prompt moves the composer into its running state.
          rind.blocks.push({ kind: "user", text: composer.text });
          composer.running = !composer.text.startsWith("/");
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
          block.reveal = graphemes(block.text).length;
          block.complete = true;
        }
        break;
      }
      case "menu": {
        const menu = rind?.composer.menu;
        if (menu?.kind === "auth-secret") menu.value = step.menu.value;
        if (menu && typeof menu.target === "number") {
          menu.selected = menu.target;
        }
        break;
      }
      case "turn-done": {
        const composer = ensureRind().composer;
        composer.running = false;
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
      case "slash-result":
      case "startup":
      case "note":
        break;
      case "info":
        ensureRind().info = { ...ensureRind().info, ...step.info };
        if (step.clear) rind.blocks = [];
        break;
      case "close-menu":
        ensureRind().composer.menu = null;
        ensureRind().composer.text = "";
        break;
      case "consume": {
        const composer = ensureRind().composer;
        const index = composer.pending.findIndex((entry) => entry.mode === step.mode);
        if (index >= 0) {
          const [entry] = composer.pending.splice(index, 1);
          rind.blocks.push({ kind: "user", text: entry.input, source: step.mode });
          if (step.mode === "follow_up") composer.running = true;
        }
        break;
      }
      case "turn-start":
        ensureRind().composer.running = true;
        if (step.input) rind.blocks.push({ kind: "user", text: step.input });
        break;
      case "expand-tools":
        expanded = step.expanded;
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
      history: structuredClone(history),
      expanded,
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
