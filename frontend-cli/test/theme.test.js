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

test("theme defaults to mocha and validates switches", () => {
  resetTheme();
  assert.equal(DEFAULT_THEME, "mocha");
  assert.deepEqual(currentTheme(), { name: "mocha", label: "Mocha" });

  assert.equal(setTheme("nope"), null);
  assert.equal(currentTheme().name, "mocha");

  assert.deepEqual(setTheme("Macchiato"), { name: "macchiato", label: "Macchiato" });
  const current = themeOptions().find((option) => option.current);
  assert.equal(current.name, "macchiato");
  assert.equal(themeOptions().length, 4);
  assert.deepEqual(themeNames(), ["latte", "frappe", "macchiato", "mocha"]);
  resetTheme();
});

test("paint honors the environment and paintRaw always emits truecolor", () => {
  resetTheme();
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
  const swatch = flavorSwatch("mocha");
  assert.ok(swatch.includes("\x1b[38;2;137;180;250m"), "uses mocha accent blue");
  assert.equal(swatch.match(/\x1b\[38;2;/g).length, 8, "shows eight hue cells");
  assert.ok(/^(█\x1b\[0m)+/.test(swatch.replace(/\x1b\[[0-9;]*m/g, "")) === false || swatch.endsWith("\x1b[0m"));
  assert.equal(swatch.replace(/\x1b\[[0-9;]*m/g, "").length, 8);
  resetTheme();
});

test("/theme command lists flavors and applies switches", async () => {
  resetTheme();
  const context = {};
  const listed = await executeLocalSlashCommand("/theme", context);
  assert.equal(listed.display.type, "theme");
  assert.equal(listed.display.changed, false);
  assert.equal(listed.display.flavors.length, 4);

  const switched = await executeLocalSlashCommand("/theme macchiato", context);
  assert.equal(switched.display.changed, true);
  assert.equal(switched.display.previous, "mocha");
  assert.equal(currentTheme().name, "macchiato");

  const unknown = await executeLocalSlashCommand("/theme dracula", context);
  assert.match(unknown.text, /Unknown theme/);
  assert.equal(currentTheme().name, "macchiato");
  resetTheme();
});

test("/theme persists only through the injected persistTheme hook", async () => {
  resetTheme();
  let persisted = null;
  const switched = await executeLocalSlashCommand("/theme latte", {
    persistTheme: (name) => {
      persisted = name;
    },
  });
  assert.equal(persisted, "latte");
  assert.equal(switched.display.changed, true);

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
    assert.equal(saveCliState({ theme: "mocha" }, root), true);
    assert.deepEqual(loadCliState(root), { theme: "mocha" });
    resetTheme();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
