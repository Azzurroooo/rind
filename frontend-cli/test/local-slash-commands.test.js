import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadLocalSettings } from "../lib/local-slash-commands.js";

test("local settings prefer a complete project configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-cli-settings-"));
  try {
    const userHome = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(userHome, ".rind"), { recursive: true });
    await mkdir(path.join(workspace, ".rind"), { recursive: true });
    await writeFile(path.join(userHome, ".rind", "settings.json"), JSON.stringify({
      apiKey: "user-key", baseUrl: "https://user.example/v1", model: "user-model",
    }));
    await writeFile(path.join(workspace, ".rind", "settings.json"), JSON.stringify({
      apiKey: "project-key", baseUrl: "https://project.example/v1", model: "project-model",
    }));

    const settings = await loadLocalSettings(path.join(userHome, ".rind"), workspace);

    assert.equal(settings.path, path.join(workspace, ".rind", "settings.json"));
    assert.equal(settings.model, "project-model");
    assert.equal(settings.hasApiKey, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local settings fall back to the user configuration when project settings are incomplete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rind-cli-settings-"));
  try {
    const userHome = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(userHome, ".rind"), { recursive: true });
    await mkdir(path.join(workspace, ".rind"), { recursive: true });
    await writeFile(path.join(userHome, ".rind", "settings.json"), JSON.stringify({
      apiKey: "user-key", baseUrl: "https://user.example/v1", model: "user-model",
    }));
    await writeFile(path.join(workspace, ".rind", "settings.json"), JSON.stringify({ model: "project-model" }));

    const settings = await loadLocalSettings(path.join(userHome, ".rind"), workspace);

    assert.equal(settings.path, path.join(userHome, ".rind", "settings.json"));
    assert.equal(settings.model, "user-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
