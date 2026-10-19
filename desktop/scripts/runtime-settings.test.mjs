import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  loadRuntimeSettings,
  maskSecretKey,
  saveRuntimeSettings,
} from "../src/main/runtime-settings.ts"

async function withTempRindHome(run) {
  const dir = await mkdtemp(join(tmpdir(), "rind-runtime-settings-test-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("latest kernel settings.json with provider and model is recognized as configured without legacy apiKey", async () => {
  await withTempRindHome(async (rindHome) => {
    await writeFile(
      join(rindHome, "settings.json"),
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-flash",
        reasoningEffort: "high",
      }),
      "utf8",
    )

    const settings = await loadRuntimeSettings(rindHome)
    assert.equal(settings.provider, "deepseek")
    assert.equal(settings.model, "deepseek-flash")
    assert.equal(settings.reasoningEffort, "high")
    assert.equal(settings.hasApiKey, true, "configured settings.json must not trigger false unconfigured warning")
  })
})

test("auth.json OAuth subscription and API keys are parsed with masked secrets", async () => {
  assert.equal(maskSecretKey("sk-1234567890abcdef"), "sk-••••cdef")
  assert.equal(maskSecretKey("short"), "••••••••")

  await withTempRindHome(async (rindHome) => {
    await writeFile(
      join(rindHome, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "acc-token",
          refresh: "ref-token",
          expires_at: 1893456000,
        },
        deepseek: {
          type: "api_key",
          key: "sk-proj-abcdef123456",
        },
      }),
      "utf8",
    )

    const settings = await loadRuntimeSettings(rindHome)
    assert.equal(settings.hasApiKey, true)
    assert.deepEqual(settings.authDetails?.openai, {
      type: "oauth",
      expiresAt: 1893456000,
    })
    assert.deepEqual(settings.authDetails?.deepseek, {
      type: "api_key",
      maskedKey: "sk-••••3456",
    })
  })
})

test("saveRuntimeSettings persists global defaults, provider credentials, and custom providers in kernel format", async () => {
  await withTempRindHome(async (rindHome) => {
    // 1. Save global defaults + provider API key
    const afterGeneral = await saveRuntimeSettings(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        reasoningEffort: "xhigh",
        providerCredential: {
          providerId: "anthropic",
          apiKey: "sk-ant-9876543210",
        },
      },
      rindHome,
    )
    assert.equal(afterGeneral.provider, "anthropic")
    assert.equal(afterGeneral.model, "claude-sonnet-4-5")
    assert.equal(afterGeneral.reasoningEffort, "xhigh")
    assert.equal(afterGeneral.authDetails?.anthropic?.type, "api_key")
    assert.equal(afterGeneral.authDetails?.anthropic?.maskedKey, "sk-••••3210")

    // Verify settings.json does NOT contain raw apiKey
    const rawSettings = JSON.parse(await readFile(join(rindHome, "settings.json"), "utf8"))
    assert.equal(rawSettings.provider, "anthropic")
    assert.equal(rawSettings.model, "claude-sonnet-4-5")
    assert.equal(rawSettings.reasoningEffort, "xhigh")
    assert.equal(rawSettings.apiKey, undefined)

    // 2. Save custom provider (providers.json + auth.json)
    const afterCustom = await saveRuntimeSettings(
      {
        customProvider: {
          name: "Xiaomi",
          api: "openai-chat",
          baseUrl: "https://api.xiaomimimo.com/v1/",
          defaultModel: "mimo-v2-flash",
          apiKey: "xm-secret-key-9999",
        },
      },
      rindHome,
    )
    const xiaomi = afterCustom.customProviders?.find((p) => p.id === "xiaomi")
    assert.ok(xiaomi)
    assert.equal(xiaomi.name, "Xiaomi")
    assert.equal(xiaomi.api, "openai-chat")
    assert.equal(xiaomi.baseUrl, "https://api.xiaomimimo.com/v1")
    assert.deepEqual(xiaomi.models, ["mimo-v2-flash"])
    assert.equal(afterCustom.authDetails?.xiaomi?.maskedKey, "xm-••••9999")

    // Verify providers.json only uses kernel-allowed keys
    const rawProviders = JSON.parse(await readFile(join(rindHome, "providers.json"), "utf8"))
    assert.deepEqual(rawProviders, {
      providers: {
        xiaomi: {
          name: "Xiaomi",
          api: "openai-chat",
          baseUrl: "https://api.xiaomimimo.com/v1",
          models: {
            "mimo-v2-flash": {},
          },
        },
      },
    })

    // 3. Delete custom provider
    const afterDelete = await saveRuntimeSettings(
      { deleteCustomProviderId: "xiaomi" },
      rindHome,
    )
    assert.equal(afterDelete.customProviders?.length, 0)
    assert.equal(afterDelete.authDetails?.xiaomi, undefined)
  })
})

test("desktop settings close button is pinned, General only shows configured providers without Workspace Override, and Providers separates Custom APIs from Built-in Providers", async () => {
  const domSource = await readFile(new URL("../src/renderer/app/dom.ts", import.meta.url), "utf8")
  const cssSource = await readFile(new URL("../src/renderer/styles/dialogs.css", import.meta.url), "utf8")
  const settingsSource = await readFile(new URL("../src/renderer/app/settings.ts", import.meta.url), "utf8")
  const providersSource = await readFile(new URL("../src/renderer/app/providers-ui.ts", import.meta.url), "utf8")

  assert.equal(
    settingsSource.includes("Configure the shared ~/.rind/settings.json before using the runtime."),
    false,
    "obsolete startup warning must not exist in settings.ts",
  )
  assert.equal(
    domSource.includes("settings-workspace-defaults") || settingsSource.includes("Workspace Override"),
    false,
    "Workspace Override must not appear in General settings",
  )
  assert.ok(
    settingsSource.includes(".filter((p) => p.configured)"),
    "General settings must filter to configured providers only",
  )
  assert.ok(
    providersSource.includes("Custom APIs") &&
      providersSource.includes("Built-in Providers") &&
      providersSource.includes("renderSingleActionControl"),
    "Providers must separate Custom APIs and Built-in Providers and render a single action control per row",
  )
  assert.ok(
    domSource.includes('<header class="settings-content-head">') &&
      domSource.includes('id="close-settings"'),
    "close-settings button must be inside settings-content-head",
  )
  assert.ok(
    cssSource.includes(".settings-content {") &&
      cssSource.includes("overflow: hidden;") &&
      cssSource.includes(".settings-panel {") &&
      cssSource.includes("overflow-y: auto;"),
    "settings-content must not scroll its header; settings-panel must scroll independently",
  )
})
