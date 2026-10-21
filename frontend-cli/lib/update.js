import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { loadCliState, saveCliState } from "./cli-state-store.js";
import { managementClient } from "./agents-client.js";
import { choiceDialogFrame } from "./rendering.js";
import { parseTerminalKey } from "./terminal-key.js";
import { Component } from "./tui/component.js";
import { createTui } from "./tui/tui.js";
import { readCliVersion } from "./version.js";
import { connectSharedRuntime, stopSharedRuntime } from "../../rind-runtime-client/shared-runtime.js";

export const UPDATE_CHECK_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_MANIFEST_BASE_URL = "https://github.com/Azzurroooo/rind/releases";
const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";

export const updateHelp = [
  "Usage: rind update [version] [--check] [--force]",
  "",
  "Check for a newer Rind release and update this installation in place.",
  "  --check   Report current version, installation channel, latest release, and PATH conflicts.",
  "  --force   Reinstall even if already on the target version, stopping active background services.",
].join("\n");

export function parseUpdateArgs(args = []) {
  const result = { help: false, check: false, force: false, targetVersion: "" };
  for (const raw of args) {
    const arg = String(raw || "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--check") {
      result.check = true;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown update option: ${arg}\n\n${updateHelp}`);
    }
    if (result.targetVersion) {
      throw new Error(`Unexpected argument: ${arg}\n\n${updateHelp}`);
    }
    const normalized = arg.toLowerCase() === "latest" ? "latest" : arg.replace(/^v/i, "");
    if (normalized !== "latest" && !parseSemver(normalized)) {
      throw new Error(`Invalid target version: ${arg}`);
    }
    result.targetVersion = normalized === "latest" ? "" : normalized;
  }
  return result;
}

export function parseSemver(version) {
  const clean = String(version ?? "").trim().replace(/^v/i, "");
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    raw: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}`,
  };
}

export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const partA = a.prerelease[i];
    const partB = b.prerelease[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    if (partA === partB) continue;
    const numA = /^\d+$/.test(partA) ? Number(partA) : null;
    const numB = /^\d+$/.test(partB) ? Number(partB) : null;
    if (numA !== null && numB !== null) return numA > numB ? 1 : -1;
    if (numA !== null) return -1;
    if (numB !== null) return 1;
    return partA > partB ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return Boolean(parseSemver(candidate) && parseSemver(current) && compareVersions(candidate, current) > 0);
}

function safeRealpath(targetPath) {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function normalizePosix(targetPath) {
  return String(targetPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(left, right, platform = process.platform) {
  const a = normalizePosix(safeRealpath(left));
  const b = normalizePosix(safeRealpath(right));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSubpath(childPath, parentPath, platform = process.platform) {
  const child = normalizePosix(safeRealpath(childPath));
  const parent = normalizePosix(safeRealpath(parentPath));
  const normChild = platform === "win32" ? child.toLowerCase() : child;
  const normParent = platform === "win32" ? parent.toLowerCase() : parent;
  return normChild === normParent || normChild.startsWith(`${normParent}/`);
}

export function standaloneRuntimeBinary(installRoot, platform = process.platform) {
  const binaryName = platform === "win32" ? "rind-runtime.exe" : "rind-runtime";
  return path.join(installRoot, "runtime", "rind-runtime", binaryName);
}

export function npmRuntimePackageName(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "@rind-ai/runtime-win32-x64";
  if (platform === "linux" && arch === "x64") return "@rind-ai/runtime-linux-x64";
  if (platform === "linux" && arch === "arm64") return "@rind-ai/runtime-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "@rind-ai/runtime-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "@rind-ai/runtime-darwin-arm64";
  return "";
}

function resolveNpmRuntimeBinary(installRoot, platform = process.platform, arch = process.arch) {
  const packageName = npmRuntimePackageName(platform, arch);
  if (!packageName) return "";
  const binaryName = platform === "win32" ? "rind-runtime.exe" : "rind-runtime";
  const anchorCandidates = [
    path.join(installRoot, "package.json"),
    path.join(installRoot, "frontend-cli", "package.json"),
  ];
  for (const anchor of anchorCandidates) {
    if (!existsSync(anchor)) continue;
    try {
      const packageRoot = path.dirname(createRequire(anchor).resolve(`${packageName}/package.json`));
      const candidate = path.join(packageRoot, "bin", binaryName);
      if (existsSync(candidate)) return candidate;
    } catch {
      // Try sibling node_modules fallback below.
    }
  }
  const [scope, pkg] = packageName.split("/");
  const siblingCandidates = [
    path.join(installRoot, "node_modules", scope, pkg, "bin", binaryName),
    path.join(path.dirname(installRoot), pkg, "bin", binaryName),
  ];
  for (const candidate of siblingCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function readPackageJson(dirPath) {
  try {
    return JSON.parse(readFileSync(path.join(dirPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function readInstallationVersion(installRoot, frontendRoot) {
  const rootPkg = readPackageJson(installRoot);
  if (typeof rootPkg?.version === "string" && rootPkg.version.trim()) return rootPkg.version.trim();
  const frontendPkg = readPackageJson(frontendRoot);
  if (typeof frontendPkg?.version === "string" && frontendPkg.version.trim()) return frontendPkg.version.trim();
  try {
    return readCliVersion(frontendRoot);
  } catch {
    return "0.0.0";
  }
}

function detectPackageManagerFromPath(installRoot) {
  const normalized = normalizePosix(installRoot).toLowerCase();
  if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/global/")) return "pnpm";
  if (normalized.includes("/.bun/install/global/") || normalized.includes("/.bun/")) return "bun";
  return "npm";
}

export function detectInstallation({
  frontendRoot = fileURLToPath(new URL("../", import.meta.url)),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const canonicalFrontend = safeRealpath(frontendRoot);
  const installRoot = path.dirname(canonicalFrontend);
  const version = readInstallationVersion(installRoot, canonicalFrontend);
  const isSource =
    existsSync(path.join(installRoot, "main.py")) &&
    existsSync(path.join(installRoot, "agent", "version.py"));
  if (isSource) {
    return {
      channel: "source",
      label: "source checkout",
      packageManager: null,
      installRoot,
      frontendRoot: canonicalFrontend,
      runtimeBinary: "",
      version,
      platform,
      arch,
    };
  }

  const rootPkg = readPackageJson(installRoot);
  const bundledRuntime = standaloneRuntimeBinary(installRoot, platform);
  const hasBundledRuntime = existsSync(bundledRuntime);
  const isNpmPackage =
    existsSync(path.join(installRoot, "lib", "runtime-check.mjs")) ||
    (rootPkg?.name === "@rind-ai/cli" && !hasBundledRuntime);

  if (isNpmPackage) {
    const packageManager = detectPackageManagerFromPath(installRoot);
    return {
      channel: "npm",
      label: `npm (${packageManager})`,
      packageManager,
      installRoot,
      frontendRoot: canonicalFrontend,
      runtimeBinary: resolveNpmRuntimeBinary(installRoot, platform, arch),
      version,
      platform,
      arch,
    };
  }

  if (hasBundledRuntime) {
    const posixRoot = normalizePosix(installRoot);
    let channel = "linux-portable";
    let label = "Linux portable archive";
    if (platform === "win32") {
      channel = "win-installer";
      label = "Windows installer";
    } else if (platform === "darwin" && posixRoot === "/usr/local/lib/rind-cli") {
      channel = "macos-pkg";
      label = "macOS pkg";
    } else if (platform === "linux" && posixRoot === "/usr/lib/rind-cli") {
      channel = "linux-deb";
      label = "Linux deb";
    }
    return {
      channel,
      label,
      packageManager: null,
      installRoot,
      frontendRoot: canonicalFrontend,
      runtimeBinary: bundledRuntime,
      version,
      platform,
      arch,
    };
  }

  return {
    channel: "unknown",
    label: "custom installation",
    packageManager: null,
    installRoot,
    frontendRoot: canonicalFrontend,
    runtimeBinary: resolveNpmRuntimeBinary(installRoot, platform, arch),
    version,
    platform,
    arch,
  };
}

function isForeignPackagedRuntime(envRuntimePath, installRoot, platform = process.platform) {
  if (!envRuntimePath) return false;
  const resolved = safeRealpath(envRuntimePath);
  const normalized = normalizePosix(resolved).toLowerCase();
  const isPackagedBinaryName =
    normalized.endsWith("/runtime/rind-runtime/rind-runtime") ||
    normalized.endsWith("/runtime/rind-runtime/rind-runtime.exe") ||
    normalized.includes("/@rind-ai/runtime-");
  if (!isPackagedBinaryName) return false;
  if (isSubpath(resolved, installRoot, platform)) return false;
  const parentNodeModules = path.dirname(installRoot);
  if (normalizePosix(parentNodeModules).toLowerCase().endsWith("/@rind-ai") && isSubpath(resolved, parentNodeModules, platform)) {
    return false;
  }
  return true;
}

export function resolveInstalledRuntime({
  repoRoot = fileURLToPath(new URL("../..", import.meta.url)),
  envRuntimePath = process.env.RIND_RUNTIME_PATH,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const installation = detectInstallation({
    frontendRoot: path.join(repoRoot, "frontend-cli"),
    platform,
    arch,
  });
  const cleanEnv = String(envRuntimePath || "").trim();
  if (cleanEnv && !isForeignPackagedRuntime(cleanEnv, installation.installRoot, platform)) {
    return cleanEnv;
  }
  return installation.runtimeBinary || "";
}

export function uninstallCommandFor(installation) {
  switch (installation.channel) {
    case "npm":
      if (installation.packageManager === "pnpm") return "pnpm remove -g @rind-ai/cli";
      if (installation.packageManager === "bun") return "bun remove -g @rind-ai/cli";
      return "npm uninstall -g @rind-ai/cli";
    case "win-installer":
      return `"${path.join(installation.installRoot, "unins000.exe")}"`;
    case "linux-deb":
      return "sudo apt remove rind-cli";
    case "macos-pkg":
      return "sudo rm -rf /usr/local/lib/rind-cli /usr/local/bin/rind && sudo pkgutil --forget ai.rind.cli";
    case "linux-portable":
      return `rm -rf "${installation.installRoot}"`;
    default:
      return "";
  }
}

function isValidInstallRoot(candidate) {
  return Boolean(
    candidate &&
      existsSync(path.join(candidate, "frontend-cli", "package.json")) &&
      existsSync(path.join(candidate, "frontend-cli", "bin", "rind.js")),
  );
}

function resolveEntryInstallRoot(entryPath) {
  const realEntry = safeRealpath(entryPath);
  const entryDir = path.dirname(realEntry);
  for (const candidate of [entryDir, path.dirname(entryDir), path.dirname(path.dirname(entryDir))]) {
    if (isValidInstallRoot(candidate)) return safeRealpath(candidate);
  }
  try {
    const stat = statSync(realEntry);
    if (!stat.isFile() || stat.size > 65536) return "";
    const content = readFileSync(realEntry, "utf8");
    if (content.includes("@rind-ai") && content.includes("rind-npm.mjs")) {
      const wrapperDir = path.dirname(path.resolve(entryPath));
      for (const candidate of [
        path.join(wrapperDir, "node_modules", "@rind-ai", "cli"),
        path.join(wrapperDir, "..", "lib", "node_modules", "@rind-ai", "cli"),
        path.join(wrapperDir, "..", "node_modules", "@rind-ai", "cli"),
      ]) {
        if (isValidInstallRoot(candidate)) return safeRealpath(candidate);
      }
    }
    for (const fixedRoot of ["/usr/local/lib/rind-cli", "/usr/lib/rind-cli"]) {
      if (content.includes(fixedRoot) && isValidInstallRoot(fixedRoot)) {
        return safeRealpath(fixedRoot);
      }
    }
    const relativeParent = path.resolve(path.dirname(path.resolve(entryPath)), "..");
    if (isValidInstallRoot(relativeParent)) return safeRealpath(relativeParent);
  } catch {
    return "";
  }
  return "";
}

export function scanPathInstallations({
  pathEnv = process.env.PATH || "",
  currentInstallRoot = "",
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const dirs = String(pathEnv || "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
  const candidateNames = platform === "win32" ? ["rind.cmd", "rind.exe", "rind"] : ["rind"];
  const installations = [];
  const seenRoots = new Set();

  for (const dir of dirs) {
    for (const name of candidateNames) {
      const entryPath = path.join(dir, name);
      if (!existsSync(entryPath)) continue;
      const installRoot = resolveEntryInstallRoot(entryPath);
      if (!installRoot) continue;
      const rootKey = platform === "win32" ? normalizePosix(installRoot).toLowerCase() : normalizePosix(installRoot);
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
      const info = detectInstallation({
        frontendRoot: path.join(installRoot, "frontend-cli"),
        platform,
        arch,
      });
      installations.push({
        ...info,
        entryPath,
        uninstallCommand: uninstallCommandFor(info),
      });
    }
  }

  const canonicalCurrent = currentInstallRoot ? safeRealpath(currentInstallRoot) : "";
  const activeOnPath = installations[0] || null;
  const shadowedBy =
    canonicalCurrent && activeOnPath && !samePath(activeOnPath.installRoot, canonicalCurrent, platform)
      ? activeOnPath
      : null;
  const duplicates = canonicalCurrent
    ? installations.filter((item) => !samePath(item.installRoot, canonicalCurrent, platform))
    : installations.slice(1);

  return { installations, activeOnPath, shadowedBy, duplicates };
}

export function formatPathConflictReport(scanResult, currentInstallation) {
  if (!scanResult) return "";
  const lines = [];
  if (scanResult.shadowedBy) {
    const active = scanResult.shadowedBy;
    lines.push(
      `Warning: PATH resolves "rind" to another installation first: v${active.version} (${active.label}) at ${active.entryPath}.`,
    );
    if (active.uninstallCommand) {
      lines.push(`  To remove the conflicting installation: ${active.uninstallCommand}`);
    }
  } else if (scanResult.duplicates.length > 0) {
    lines.push(
      `Note: Found ${scanResult.duplicates.length} other Rind installation${scanResult.duplicates.length === 1 ? "" : "s"} on PATH:`,
    );
    for (const dup of scanResult.duplicates) {
      lines.push(`  - v${dup.version} (${dup.label}) at ${dup.installRoot}`);
      if (dup.uninstallCommand) {
        lines.push(`    Uninstall: ${dup.uninstallCommand}`);
      }
    }
  }
  return lines.join("\n");
}

function expectedCliAssetFilter(channel, arch) {
  if (channel === "win-installer") {
    return (asset) => asset.product === "cli" && asset.target === "windows-x64" && String(asset.name).endsWith(".exe");
  }
  if (channel === "macos-pkg") {
    const target = arch === "arm64" ? "macos-arm64" : "macos-x64";
    return (asset) => asset.product === "cli" && asset.target === target && String(asset.name).endsWith(".pkg");
  }
  if (channel === "linux-deb") {
    const target = arch === "arm64" ? "linux-arm64" : "linux-x64";
    return (asset) => asset.product === "cli" && asset.target === target && String(asset.name).endsWith(".deb");
  }
  if (channel === "linux-portable") {
    const target = arch === "arm64" ? "linux-arm64" : "linux-x64";
    return (asset) => asset.product === "cli" && asset.target === target && String(asset.name).endsWith(".tar.gz");
  }
  return null;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "rind-cli-updater" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} when fetching ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLatestRelease({
  installation = detectInstallation(),
  targetVersion = "",
  fetchImpl = globalThis.fetch,
  manifestBaseUrl = process.env.RIND_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_BASE_URL,
  npmRegistryUrl = process.env.RIND_UPDATE_NPM_REGISTRY_URL || DEFAULT_NPM_REGISTRY_URL,
  timeoutMs = 8000,
} = {}) {
  const cleanBase = String(manifestBaseUrl).replace(/\/+$/, "");
  const cleanRegistry = String(npmRegistryUrl).replace(/\/+$/, "");

  if (installation.channel === "npm") {
    const tagOrVersion = targetVersion || "latest";
    const cliMeta = await fetchJson(`${cleanRegistry}/@rind-ai%2fcli/${encodeURIComponent(tagOrVersion)}`, {
      fetchImpl,
      timeoutMs,
    });
    const resolvedVersion = String(cliMeta?.version || "").trim();
    if (!parseSemver(resolvedVersion)) {
      throw new Error("npm registry returned an invalid @rind-ai/cli version.");
    }
    const runtimePkg = npmRuntimePackageName(installation.platform, installation.arch);
    if (runtimePkg) {
      const encodedRuntime = runtimePkg.replace("/", "%2f");
      const runtimeMeta = await fetchJson(`${cleanRegistry}/${encodedRuntime}/${encodeURIComponent(resolvedVersion)}`, {
        fetchImpl,
        timeoutMs,
      }).catch(() => null);
      if (!runtimeMeta?.dist?.tarball) {
        throw new Error(`Platform runtime package ${runtimePkg}@${resolvedVersion} is not published on npm yet.`);
      }
    }
    return {
      version: resolvedVersion,
      channel: "npm",
      asset: null,
    };
  }

  const manifestUrl = targetVersion
    ? `${cleanBase}/download/v${targetVersion}/release-manifest.json`
    : `${cleanBase}/latest/download/release-manifest.json`;
  const manifest = await fetchJson(manifestUrl, { fetchImpl, timeoutMs });
  const resolvedVersion = String(manifest?.version || "").trim().replace(/^v/i, "");
  if (!parseSemver(resolvedVersion)) {
    throw new Error("Release manifest does not contain a valid version.");
  }

  const matcher = expectedCliAssetFilter(installation.channel, installation.arch);
  let asset = null;
  if (matcher && Array.isArray(manifest?.assets)) {
    const matched = manifest.assets.find(matcher);
    if (!matched) {
      throw new Error(`Release v${resolvedVersion} does not provide an artifact for ${installation.label} (${installation.platform}/${installation.arch}).`);
    }
    asset = {
      name: String(matched.name),
      bytes: Number(matched.bytes) || 0,
      sha256: String(matched.sha256 || "").trim().toLowerCase(),
      url: matched.url
        ? String(matched.url)
        : `${cleanBase}/download/v${resolvedVersion}/${encodeURIComponent(String(matched.name))}`,
    };
  }

  return {
    version: resolvedVersion,
    channel: installation.channel,
    asset,
  };
}

export function readUpdateCache(rindHome) {
  const state = loadCliState(rindHome);
  const raw = state.updateCheck && typeof state.updateCheck === "object" ? state.updateCheck : {};
  return {
    checkedAt: Number(raw.checkedAt) || 0,
    latestVersion: typeof raw.latestVersion === "string" ? raw.latestVersion.trim() : "",
    dismissedVersion: typeof raw.dismissedVersion === "string" ? raw.dismissedVersion.trim() : "",
  };
}

export function writeUpdateCache(patch, rindHome) {
  const current = readUpdateCache(rindHome);
  const next = {
    checkedAt: patch.checkedAt ?? current.checkedAt,
    latestVersion: patch.latestVersion ?? current.latestVersion,
    ...(patch.dismissedVersion !== undefined
      ? patch.dismissedVersion
        ? { dismissedVersion: patch.dismissedVersion }
        : {}
      : current.dismissedVersion
        ? { dismissedVersion: current.dismissedVersion }
        : {}),
  };
  saveCliState({ updateCheck: next }, rindHome);
  return next;
}

export function shouldPromptStartupUpdate({
  installation = detectInstallation(),
  rindHome,
  env = process.env,
} = {}) {
  if (env.RIND_DISABLE_UPDATE_CHECK === "1") return null;
  if (installation.channel === "source" || installation.channel === "unknown") return null;
  const cache = readUpdateCache(rindHome);
  if (!cache.latestVersion || !isNewerVersion(cache.latestVersion, installation.version)) return null;
  if (cache.dismissedVersion === cache.latestVersion) return null;
  return cache.latestVersion;
}

export function refreshUpdateCacheInBackground({
  installation = detectInstallation(),
  rindHome,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now(),
} = {}) {
  if (env.RIND_DISABLE_UPDATE_CHECK === "1") return null;
  if (installation.channel === "source" || installation.channel === "unknown") return null;
  const cache = readUpdateCache(rindHome);
  if (cache.checkedAt > 0 && now - cache.checkedAt < UPDATE_CHECK_TTL_MS) return null;

  return checkLatestRelease({ installation, fetchImpl, timeoutMs: 5000 })
    .then((release) => {
      const current = readUpdateCache(rindHome);
      const keepDismissed = current.dismissedVersion === release.version ? current.dismissedVersion : "";
      return writeUpdateCache(
        {
          checkedAt: Date.now(),
          latestVersion: release.version,
          dismissedVersion: keepDismissed,
        },
        rindHome,
      );
    })
    .catch(() => null);
}

class StartupUpdateDialog extends Component {
  constructor({ currentVersion, latestVersion, label, selectedIndex = 0 }) {
    super();
    this.currentVersion = currentVersion;
    this.latestVersion = latestVersion;
    this.label = label;
    this.selectedIndex = selectedIndex;
    this.options = [
      `Update now · install v${latestVersion} now`,
      "Skip · continue to Rind",
      `Skip until next version · do not ask again for v${latestVersion}`,
    ];
  }

  render(width) {
    return choiceDialogFrame({
      title: `Update available · v${this.currentVersion} → v${this.latestVersion}`,
      message: `A newer version of Rind is available (${this.label}).`,
      options: this.options,
      selectedIndex: this.selectedIndex,
      width,
    })
      .trimEnd()
      .split("\n");
  }
}

export async function promptStartupUpdate({
  installation = detectInstallation(),
  latestVersion,
  input = process.stdin,
  output = process.stdout,
  rindHome,
} = {}) {
  const dialog = new StartupUpdateDialog({
    currentVersion: installation.version,
    latestVersion,
    label: installation.label,
  });
  const tui = createTui({ input, output });
  tui.addChild(dialog);

  const choice = await new Promise((resolve) => {
    const finish = (action) => resolve(action);
    tui.onData((sequence) => {
      const key = parseTerminalKey(sequence);
      if (key.name === "up" || (key.kind === "text" && key.text === "k")) {
        dialog.selectedIndex = (dialog.selectedIndex - 1 + dialog.options.length) % dialog.options.length;
        tui.requestRender();
        return;
      }
      if (key.name === "down" || (key.kind === "text" && key.text === "j")) {
        dialog.selectedIndex = (dialog.selectedIndex + 1) % dialog.options.length;
        tui.requestRender();
        return;
      }
      if (key.name === "enter") {
        finish(dialog.selectedIndex === 0 ? "update" : dialog.selectedIndex === 2 ? "dismiss" : "skip");
        return;
      }
      if (key.name === "escape" || key.name === "ctrl+c") {
        finish("skip");
      }
    });
    tui.onPaste(() => {});
    input.once?.("end", () => finish("skip"));
    input.once?.("close", () => finish("skip"));
    tui.start();
    tui.requestRender();
  }).finally(() => {
    tui.stop();
  });

  if (choice === "dismiss") {
    writeUpdateCache({ dismissedVersion: latestVersion }, rindHome);
  }
  return choice;
}

export async function quiesceBackgroundServices({
  home = process.env.RIND_HOME,
  force = false,
  connectManagementImpl = managementClient,
  connectRuntimeImpl = connectSharedRuntime,
  stopRuntimeImpl = stopSharedRuntime,
} = {}) {
  const mgmt = await connectManagementImpl({ home, start: false }).catch(() => null);
  if (mgmt) {
    try {
      await mgmt.request("serviceShutdown", { stopAgents: force });
    } catch (error) {
      if (error?.code === "SERVICE_BUSY" && !force) {
        throw new Error(
          'Rind has active conversations or background tasks. Wait for them to finish, run "rind agents stop --all", or pass "--force".',
        );
      }
      if (!force && error?.code !== "UNKNOWN_METHOD") throw error;
    } finally {
      mgmt.close();
    }
  }

  const runtime = await connectRuntimeImpl({ rindHome: home, start: false }).catch(() => null);
  if (runtime) {
    try {
      const info = await runtime.request("runtime/info").catch(() => null);
      const activeCount = (Number(info?.busy) || 0) + (Number(info?.attached) || 0);
      if (activeCount > 0 && !force) {
        throw new Error(
          'Rind has active conversations or background tasks. Wait for them to finish, run "rind agents stop --all", or pass "--force".',
        );
      }
      await runtime.request("runtime/shutdown").catch(() => {});
    } finally {
      runtime.close();
    }
  }
  await stopRuntimeImpl({ rindHome: home }).catch(() => false);
}

function sanitizeAbsolutePathEnv(pathEnv = process.env.PATH || "", platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(pathEnv)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && (platform === "win32" ? path.win32.isAbsolute(entry) : path.posix.isAbsolute(entry)))
    .join(delimiter);
}

function hasWriteAccess(targetPath) {
  try {
    const checkPath = existsSync(targetPath) ? targetPath : path.dirname(targetPath);
    accessSync(checkPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function downloadAndVerifyAsset(asset, destinationPath, { fetchImpl = globalThis.fetch } = {}) {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const response = await fetchImpl(asset.url, {
    headers: { "User-Agent": "rind-cli-updater" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.name}: HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let bytesReceived = 0;
  const fileStream = createWriteStream(destinationPath);
  const bodyStream = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
  bodyStream.on("data", (chunk) => {
    bytesReceived += chunk.length;
    hash.update(chunk);
  });
  await pipeline(bodyStream, fileStream);

  if (asset.bytes > 0 && bytesReceived !== asset.bytes) {
    rmSync(destinationPath, { force: true });
    throw new Error(`Downloaded size mismatch for ${asset.name}: expected ${asset.bytes} bytes, got ${bytesReceived}.`);
  }
  const actualSha256 = hash.digest("hex").toLowerCase();
  if (asset.sha256 && actualSha256 !== asset.sha256.toLowerCase()) {
    rmSync(destinationPath, { force: true });
    throw new Error(`SHA256 verification failed for ${asset.name}.`);
  }
  return destinationPath;
}

export function buildNpmUpdateCommand(packageManager, targetVersion, platform = process.platform) {
  const spec = `@rind-ai/cli@${targetVersion}`;
  if (packageManager === "pnpm") {
    return {
      command: platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["add", "-g", spec],
      display: `pnpm add -g ${spec}`,
    };
  }
  if (packageManager === "bun") {
    return {
      command: platform === "win32" ? "bun.exe" : "bun",
      args: ["install", "-g", spec],
      display: `bun install -g ${spec}`,
    };
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "-g", spec, "--include=optional", "--no-fund", "--no-audit"],
    display: `npm install -g ${spec} --include=optional`,
  };
}

function findExtractedPortableRoot(stagingDir) {
  if (isValidInstallRoot(stagingDir)) return stagingDir;
  const entries = readdirSync(stagingDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(stagingDir, entry.name);
    if (isValidInstallRoot(candidate)) return candidate;
  }
  throw new Error("Downloaded portable archive does not contain a valid Rind CLI layout.");
}

function installPortableArchive({ archivePath, installRoot, expectedVersion, spawnSyncImpl = spawnSync, platform = process.platform }) {
  const parentDir = path.dirname(installRoot);
  const stagingDir = path.join(parentDir, `.rind-update-staging-${process.pid}-${Date.now()}`);
  const backupDir = `${installRoot}.bak-${process.pid}`;
  mkdirSync(stagingDir, { recursive: true });
  try {
    const extractResult = spawnSyncImpl("tar", ["-xzf", archivePath, "-C", stagingDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (extractResult.status !== 0) {
      throw new Error(`Failed to extract archive: ${(extractResult.stderr || extractResult.stdout || "").trim()}`);
    }
    const stagedRoot = findExtractedPortableRoot(stagingDir);
    const stagedRuntime = standaloneRuntimeBinary(stagedRoot, platform);
    const smoke = spawnSyncImpl(stagedRuntime, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, RIND_RUNTIME_PATH: stagedRuntime },
    });
    if (smoke.status !== 0 || !String(smoke.stdout || "").includes(expectedVersion)) {
      throw new Error(`Updated runtime failed pre-activation self-check: ${(smoke.stderr || smoke.stdout || "").trim()}`);
    }
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(installRoot, backupDir);
    try {
      renameSync(stagedRoot, installRoot);
    } catch (swapError) {
      if (!existsSync(installRoot) && existsSync(backupDir)) {
        renameSync(backupDir, installRoot);
      }
      throw swapError;
    }
    rmSync(backupDir, { recursive: true, force: true });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function runUpdate({
  args = [],
  installation = detectInstallation(),
  rindHome = process.env.RIND_HOME,
  pathEnv = process.env.PATH,
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  fetchImpl = globalThis.fetch,
  spawnSyncImpl = spawnSync,
  quiesceImpl = quiesceBackgroundServices,
} = {}) {
  const options = parseUpdateArgs(args);
  if (options.help) {
    stdout(updateHelp);
    return 0;
  }

  const pathScan = scanPathInstallations({
    pathEnv,
    currentInstallRoot: installation.installRoot,
    platform: installation.platform,
    arch: installation.arch,
  });
  const conflictReport = formatPathConflictReport(pathScan, installation);

  if (installation.channel === "source" && !options.check) {
    stdout(`Rind v${installation.version} is running from a source checkout (${installation.installRoot}).`);
    stdout("Update your checkout with: git pull && python -m pip install -r requirements-runtime.txt && npm run build --prefix agent-management");
    if (conflictReport) stdout(`\n${conflictReport}`);
    return 0;
  }

  if (installation.channel === "unknown" && !options.check) {
    stderr(`Cannot automatically update custom installation at ${installation.installRoot}.`);
    if (conflictReport) stderr(conflictReport);
    return 1;
  }

  const release = await checkLatestRelease({
    installation,
    targetVersion: options.targetVersion,
    fetchImpl,
  });

  writeUpdateCache(
    {
      checkedAt: Date.now(),
      latestVersion: release.version,
    },
    rindHome,
  );

  const updateAvailable = options.targetVersion
    ? options.targetVersion !== installation.version
    : isNewerVersion(release.version, installation.version);

  if (options.check) {
    stdout(`Rind v${installation.version} · ${installation.label} (${installation.installRoot})`);
    if (updateAvailable) {
      stdout(`Update available: v${installation.version} → v${release.version} (run "rind update" to install)`);
    } else {
      stdout(`Up to date (latest: v${release.version}).`);
    }
    if (conflictReport) stdout(`\n${conflictReport}`);
    return 0;
  }

  if (!updateAvailable && !options.force) {
    stdout(`Rind v${installation.version} (${installation.label}) is already up to date.`);
    if (conflictReport) stdout(`\n${conflictReport}`);
    return 0;
  }

  await quiesceImpl({ home: rindHome, force: options.force });

  if (installation.channel === "npm") {
    const cmd = buildNpmUpdateCommand(installation.packageManager, release.version, installation.platform);
    if (!hasWriteAccess(installation.installRoot)) {
      stderr(`Insufficient permissions to update ${installation.installRoot}.`);
      stderr(`Run with elevated permissions: ${installation.platform === "win32" ? cmd.display : `sudo ${cmd.display}`}`);
      return 1;
    }
    stdout(`Updating Rind v${installation.version} → v${release.version} via ${installation.packageManager}...`);
    const result = spawnSyncImpl(cmd.command, cmd.args, {
      cwd: os.tmpdir(),
      stdio: "inherit",
      windowsHide: true,
      shell: installation.platform === "win32",
      env: {
        ...process.env,
        PATH: sanitizeAbsolutePathEnv(pathEnv, installation.platform),
        RIND_RUNTIME_PATH: "",
      },
    });
    if (result.status !== 0) {
      throw new Error(`Package manager exited with status ${result.status ?? 1}.`);
    }
  } else if (installation.channel === "win-installer") {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rind-update-"));
    try {
      const installerPath = path.join(tempDir, release.asset.name);
      stdout(`Downloading ${release.asset.name}...`);
      await downloadAndVerifyAsset(release.asset, installerPath, { fetchImpl });
      stdout(`Installing Rind v${release.version}...`);
      const result = spawnSyncImpl(
        installerPath,
        [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
          "/CLOSEAPPLICATIONS",
          `/DIR=${installation.installRoot}`,
        ],
        {
          cwd: os.tmpdir(),
          stdio: "inherit",
          windowsHide: true,
        },
      );
      if (result.status !== 0) {
        throw new Error(`Windows installer exited with status ${result.status ?? 1}.`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } else if (installation.channel === "linux-portable") {
    if (!hasWriteAccess(installation.installRoot) || !hasWriteAccess(path.dirname(installation.installRoot))) {
      stderr(`Insufficient permissions to update ${installation.installRoot}.`);
      return 1;
    }
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rind-update-"));
    try {
      const archivePath = path.join(tempDir, release.asset.name);
      stdout(`Downloading ${release.asset.name}...`);
      await downloadAndVerifyAsset(release.asset, archivePath, { fetchImpl });
      stdout(`Installing Rind v${release.version}...`);
      installPortableArchive({
        archivePath,
        installRoot: installation.installRoot,
        expectedVersion: release.version,
        spawnSyncImpl,
        platform: installation.platform,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } else if (installation.channel === "macos-pkg" || installation.channel === "linux-deb") {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "rind-update-"));
    try {
      const packagePath = path.join(tempDir, release.asset.name);
      stdout(`Downloading ${release.asset.name}...`);
      await downloadAndVerifyAsset(release.asset, packagePath, { fetchImpl });
      const needsSudo = typeof process.getuid === "function" && process.getuid() !== 0;
      const baseArgs =
        installation.channel === "macos-pkg"
          ? ["installer", "-pkg", packagePath, "-target", "/"]
          : ["dpkg", "-i", packagePath];
      const command = needsSudo ? "sudo" : baseArgs[0];
      const commandArgs = needsSudo ? baseArgs : baseArgs.slice(1);
      stdout(`Installing Rind v${release.version}${needsSudo ? " (sudo required)" : ""}...`);
      const result = spawnSyncImpl(command, commandArgs, {
        cwd: os.tmpdir(),
        stdio: "inherit",
      });
      if (result.status !== 0) {
        throw new Error(`System package installer exited with status ${result.status ?? 1}.`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  writeUpdateCache(
    {
      checkedAt: Date.now(),
      latestVersion: release.version,
      dismissedVersion: "",
    },
    rindHome,
  );
  stdout(`Updated Rind from v${installation.version} to v${release.version} (${installation.label}).`);
  if (conflictReport) stdout(`\n${conflictReport}`);
  return 0;
}
