import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THEME,
  currentTheme,
  flavorSwatch,
  paint,
  paintRaw,
  resetTheme,
  setTheme,
  themeNames,
  themeOptions,
} from "../lib/theme.js";
import { executeLocalSlashCommand } from "../lib/local-slash-commands.js";
import { cliStatePath, loadCliState, saveCliState } from "../lib/cli-state-store.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("theme defaults to Frappé and validates switches", () => {
  resetTheme();
  assert.equal(DEFAULT_THEME, "frappe");
  assert.deepEqual(currentTheme(), { name: "frappe", label: "Frappé" });

  assert.equal(setTheme("nope"), null);
  assert.equal(setTheme("macchiato"), null);
  assert.equal(setTheme("mocha"), null);
  assert.equal(currentTheme().name, "frappe");

  assert.deepEqual(setTheme("Dracula"), { name: "dracula", label: "Dracula" });
  const current = themeOptions().find((option) => option.current);
  assert.equal(current.name, "dracula");
  assert.equal(themeOptions().length, 9);
  assert.deepEqual(themeNames(), ["latte", "frappe", "dracula", "gruvbox-dark", "catppuccin-mocha", "solarized-dark", "rose-pine", "everforest-dark-medium", "pistachio"]);
  assert.deepEqual(setTheme("rind"), { name: "pistachio", label: "Pistachio" });
  resetTheme();
});

test("paint honors the environment and paintRaw always emits truecolor", () => {
  setTheme("catppuccin-mocha");
  const originalIsTty = process.stdout.isTTY;
  const originalNoColor = process.env.NO_COLOR;
  try {
    process.stdout.isTTY = false;
    delete process.env.NO_COLOR;
    assert.equal(paint.accent("x"), "x");
    assert.equal(paintRaw.success("x"), "\x1b[38;2;166;227;161mx\x1b[0m");

    process.stdout.isTTY = true;
    assert.equal(paint.danger("x"), "\x1b[38;2;243;139;168mx\x1b[0m");
    assert.equal(paintRaw.warning("x"), "\x1b[38;2;249;226;175mx\x1b[0m");

    process.env.NO_COLOR = "1";
    assert.equal(paint.accent("x"), "x");
    assert.equal(paint.dim("y"), "y");
    assert.equal(paintRaw.notice("z"), "\x1b[38;2;203;166;247mz\x1b[0m");
  } finally {
    resetTheme();
    if (originalIsTty === undefined) {
      delete process.stdout.isTTY;
    } else {
      process.stdout.isTTY = originalIsTty;
    }
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  }
});

test("flavor swatches render in the target flavor regardless of active theme", () => {
  setTheme("latte");
  const swatch = flavorSwatch("catppuccin-mocha");
  assert.ok(swatch.includes("\x1b[38;2;137;180;250m"), "uses mocha accent blue");
  assert.equal(swatch.match(/\x1b\[38;2;/g).length, 8, "shows eight hue cells");
  assert.ok(/^(█\x1b\[0m)+/.test(swatch.replace(/\x1b\[[0-9;]*m/g, "")) === false || swatch.endsWith("\x1b[0m"));
  assert.equal(swatch.replace(/\x1b\[[0-9;]*m/g, "").length, 8);
  for (const name of themeNames()) {
    assert.equal(flavorSwatch(name).replace(/\x1b\[[0-9;]*m/g, ""), "█".repeat(8));
    assert.ok(!flavorSwatch(name).includes("\x1b[48;"), `${name} must preserve the terminal background`);
  }
  resetTheme();
});

test("/theme command lists flavors and applies switches", async () => {
  resetTheme();
  const context = {};
  const listed = await executeLocalSlashCommand("/theme", context);
  assert.equal(listed.display.type, "theme");
  assert.equal(listed.display.changed, false);
  assert.equal(listed.display.flavors.length, 9);

  const switched = await executeLocalSlashCommand("/theme dracula", context);
  assert.equal(switched.display.changed, true);
  assert.equal(switched.display.previous, "frappe");
  assert.equal(currentTheme().name, "dracula");

  const unknown = await executeLocalSlashCommand("/theme missing", context);
  assert.match(unknown.text, /Unknown theme/);
  assert.equal(currentTheme().name, "dracula");
  resetTheme();
});

test("/theme persists only through the injected persistTheme hook", async () => {
  resetTheme();
  let persisted = null;
  const switched = await executeLocalSlashCommand("/theme pistachio", {
    persistTheme: (name) => {
      persisted = name;
    },
  });
  assert.equal(persisted, "pistachio");
  assert.equal(switched.display.changed, true);
  assert.deepEqual(currentTheme(), { name: "pistachio", label: "Pistachio" });

  const bare = await executeLocalSlashCommand("/theme", {});
  assert.equal(bare.display.changed, false);
  resetTheme();
});

test("cli state store merges patches atomically and tolerates corruption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-cli-state-"));
  try {
    assert.deepEqual(loadCliState(root), {});
    assert.equal(saveCliState({ theme: "latte" }, root), true);
    assert.equal(saveCliState({ future: true }, root), true);
    assert.deepEqual(loadCliState(root), { theme: "latte", future: true });
    assert.ok(loadCliState(root).theme === "latte");

    await writeFile(path.join(root, "cli-state.json"), "{broken", "utf8");
    assert.deepEqual(loadCliState(root), {});
    assert.equal(saveCliState({ theme: "catppuccin-mocha" }, root), true);
    assert.deepEqual(loadCliState(root), { theme: "catppuccin-mocha" });
    resetTheme();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
