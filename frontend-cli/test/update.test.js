import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  UPDATE_CHECK_TTL_MS,
  buildNpmUpdateCommand,
  checkLatestRelease,
  compareVersions,
  detectInstallation,
  downloadAndVerifyAsset,
  formatPathConflictReport,
  isNewerVersion,
  parseSemver,
  parseUpdateArgs,
  promptStartupUpdate,
  quiesceBackgroundServices,
  readUpdateCache,
  refreshUpdateCacheInBackground,
  resolveInstalledRuntime,
  runUpdate,
  scanPathInstallations,
  shouldPromptStartupUpdate,
  writeUpdateCache,
} from "../lib/update.js";

function withTempDir(t, prefix = "rind-update-test-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeCliTree(rootDir, { version = "0.10.0", channel = "npm", platform = "win32", arch = "x64" } = {}) {
  const frontendDir = path.join(rootDir, "frontend-cli");
  mkdirSync(path.join(frontendDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(frontendDir, "package.json"),
    JSON.stringify({ name: "rind-frontend-cli", version }, null, 2),
  );
  writeFileSync(path.join(frontendDir, "bin", "rind.js"), "#!/usr/bin/env node\n");

  if (channel === "source") {
    mkdirSync(path.join(rootDir, "agent"), { recursive: true });
    writeFileSync(path.join(rootDir, "main.py"), "print('rind')\n");
    writeFileSync(path.join(rootDir, "agent", "version.py"), `__version__ = "${version}"\n`);
  } else if (channel === "npm") {
    mkdirSync(path.join(rootDir, "lib"), { recursive: true });
    mkdirSync(path.join(rootDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "@rind-ai/cli", version }, null, 2),
    );
    writeFileSync(path.join(rootDir, "lib", "runtime-check.mjs"), "export {};\n");
    writeFileSync(path.join(rootDir, "bin", "rind-npm.mjs"), "#!/usr/bin/env node\n");
    const runtimeFolder = `runtime-${platform}-${arch}`;
    const runtimeBinDir = path.join(rootDir, "node_modules", "@rind-ai", runtimeFolder, "bin");
    mkdirSync(runtimeBinDir, { recursive: true });
    writeFileSync(
      path.join(rootDir, "node_modules", "@rind-ai", runtimeFolder, "package.json"),
      JSON.stringify({ name: `@rind-ai/${runtimeFolder}`, version }, null, 2),
    );
    const binName = platform === "win32" ? "rind-runtime.exe" : "rind-runtime";
    writeFileSync(path.join(runtimeBinDir, binName), "binary");
  } else {
    const runtimeDir = path.join(rootDir, "runtime", "rind-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const binName = platform === "win32" ? "rind-runtime.exe" : "rind-runtime";
    writeFileSync(path.join(runtimeDir, binName), `#!/bin/sh\necho "rind ${version}"\n`);
    if (platform !== "win32") {
      chmodSync(path.join(runtimeDir, binName), 0o755);
    }
    if (platform === "win32") {
      mkdirSync(path.join(rootDir, "bin"), { recursive: true });
      writeFileSync(path.join(rootDir, "bin", "rind.cmd"), '@echo off\r\nnode "%~dp0\\..\\frontend-cli\\bin\\rind.js" %*\r\n');
      writeFileSync(path.join(rootDir, "unins000.exe"), "uninstall");
    } else {
      writeFileSync(path.join(rootDir, "rind"), '#!/usr/bin/env sh\nexec node "$(dirname "$0")/frontend-cli/bin/rind.js" "$@"\n');
    }
  }
  return { rootDir, frontendDir };
}

test("parseSemver, compareVersions, and isNewerVersion follow SemVer rules", () => {
  assert.deepEqual(parseSemver("v0.10.1"), {
    major: 0,
    minor: 10,
    patch: 1,
    prerelease: [],
    raw: "0.10.1",
  });
  assert.equal(parseSemver("not-a-version"), null);
  assert.equal(compareVersions("0.10.1", "0.10.0"), 1);
  assert.equal(compareVersions("0.10.0", "0.10.0"), 0);
  assert.equal(compareVersions("0.10.0-beta.1", "0.10.0"), -1);
  assert.equal(compareVersions("0.10.0-beta.2", "0.10.0-beta.1"), 1);
  assert.equal(isNewerVersion("0.11.0", "0.10.9"), true);
  assert.equal(isNewerVersion("0.10.0", "0.10.0"), false);
});

test("parseUpdateArgs validates flags and target version", () => {
  assert.deepEqual(parseUpdateArgs([]), {
    help: false,
    check: false,
    force: false,
    targetVersion: "",
  });
  assert.deepEqual(parseUpdateArgs(["v0.11.0", "--force"]), {
    help: false,
    check: false,
    force: true,
    targetVersion: "0.11.0",
  });
  assert.deepEqual(parseUpdateArgs(["--check", "latest"]), {
    help: false,
    check: true,
    force: false,
    targetVersion: "",
  });
  assert.throws(() => parseUpdateArgs(["--unknown"]), /Unknown update option/);
  assert.throws(() => parseUpdateArgs(["invalid.ver"]), /Invalid target version/);
});

test("detectInstallation identifies source, npm (npm/pnpm/bun), win-installer, and linux-portable layouts", (t) => {
  const base = withTempDir(t);

  const sourceTree = createFakeCliTree(path.join(base, "source"), { version: "0.10.0", channel: "source" });
  const sourceInfo = detectInstallation({ frontendRoot: sourceTree.frontendDir, platform: "win32", arch: "x64" });
  assert.equal(sourceInfo.channel, "source");
  assert.equal(sourceInfo.version, "0.10.0");
  assert.equal(sourceInfo.runtimeBinary, "");

  const npmTree = createFakeCliTree(path.join(base, "npm-global", "node_modules", "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "win32",
    arch: "x64",
  });
  const npmInfo = detectInstallation({ frontendRoot: npmTree.frontendDir, platform: "win32", arch: "x64" });
  assert.equal(npmInfo.channel, "npm");
  assert.equal(npmInfo.packageManager, "npm");
  assert.ok(npmInfo.runtimeBinary.endsWith(path.join("@rind-ai", "runtime-win32-x64", "bin", "rind-runtime.exe")));

  const pnpmTree = createFakeCliTree(path.join(base, ".pnpm", "@rind-ai+cli@0.10.0", "node_modules", "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "linux",
    arch: "x64",
  });
  const pnpmInfo = detectInstallation({ frontendRoot: pnpmTree.frontendDir, platform: "linux", arch: "x64" });
  assert.equal(pnpmInfo.channel, "npm");
  assert.equal(pnpmInfo.packageManager, "pnpm");

  const bunTree = createFakeCliTree(path.join(base, ".bun", "install", "global", "node_modules", "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "darwin",
    arch: "arm64",
  });
  const bunInfo = detectInstallation({ frontendRoot: bunTree.frontendDir, platform: "darwin", arch: "arm64" });
  assert.equal(bunInfo.channel, "npm");
  assert.equal(bunInfo.packageManager, "bun");

  const winTree = createFakeCliTree(path.join(base, "Rind CLI"), {
    version: "0.10.0",
    channel: "win-installer",
    platform: "win32",
    arch: "x64",
  });
  const winInfo = detectInstallation({ frontendRoot: winTree.frontendDir, platform: "win32", arch: "x64" });
  assert.equal(winInfo.channel, "win-installer");
  assert.ok(winInfo.runtimeBinary.endsWith(path.join("runtime", "rind-runtime", "rind-runtime.exe")));

  const portableTree = createFakeCliTree(path.join(base, "rind-portable"), {
    version: "0.10.0",
    channel: "linux-portable",
    platform: "linux",
    arch: "x64",
  });
  const portableInfo = detectInstallation({ frontendRoot: portableTree.frontendDir, platform: "linux", arch: "x64" });
  assert.equal(portableInfo.channel, "linux-portable");
  assert.ok(portableInfo.runtimeBinary.endsWith(path.join("runtime", "rind-runtime", "rind-runtime")));
});

test("resolveInstalledRuntime isolates against leaked RIND_RUNTIME_PATH from another installation", (t) => {
  const base = withTempDir(t);
  const winTree = createFakeCliTree(path.join(base, "win-install"), {
    version: "0.9.0",
    channel: "win-installer",
    platform: "win32",
    arch: "x64",
  });
  const npmTree = createFakeCliTree(path.join(base, "npm-install", "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "win32",
    arch: "x64",
  });
  const sourceTree = createFakeCliTree(path.join(base, "source-checkout"), {
    version: "0.10.0",
    channel: "source",
    platform: "win32",
    arch: "x64",
  });

  const leakedWinRuntime = path.join(winTree.rootDir, "runtime", "rind-runtime", "rind-runtime.exe");

  // npm installation ignores leaked win-installer RIND_RUNTIME_PATH and uses its own @rind-ai/runtime-*
  const resolvedForNpm = resolveInstalledRuntime({
    repoRoot: npmTree.rootDir,
    envRuntimePath: leakedWinRuntime,
    platform: "win32",
    arch: "x64",
  });
  assert.ok(resolvedForNpm.includes(path.join("npm-install", "@rind-ai", "cli")));

  // source checkout ignores leaked packaged RIND_RUNTIME_PATH so it runs Python main.py
  const resolvedForSource = resolveInstalledRuntime({
    repoRoot: sourceTree.rootDir,
    envRuntimePath: leakedWinRuntime,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(resolvedForSource, "");

  // Explicit test double (not a packaged runtime layout) is still honored
  const customHarnessPath = path.join(base, "custom-mock-runtime.cmd");
  writeFileSync(customHarnessPath, "@echo off\r\n");
  assert.equal(
    resolveInstalledRuntime({
      repoRoot: sourceTree.rootDir,
      envRuntimePath: customHarnessPath,
      platform: "win32",
      arch: "x64",
    }),
    customHarnessPath,
  );
});

test("scanPathInstallations detects dual installations and shadowing on PATH", (t) => {
  const base = withTempDir(t);

  // 1. npm global bin directory with wrapperrind.cmd -> node_modules/@rind-ai/cli
  const npmBinDir = path.join(base, "npm-bin");
  const npmPkgDir = path.join(npmBinDir, "node_modules", "@rind-ai", "cli");
  createFakeCliTree(npmPkgDir, { version: "0.9.0", channel: "npm", platform: "win32", arch: "x64" });
  writeFileSync(
    path.join(npmBinDir, "rind.cmd"),
    '@echo off\r\nnode "%~dp0\\node_modules\\@rind-ai\\cli\\bin\\rind-npm.mjs" %*\r\n',
  );

  // 2. Windows Inno Setup installation with bin/rind.cmd
  const winInstallDir = path.join(base, "Programs", "Rind CLI");
  const winTree = createFakeCliTree(winInstallDir, {
    version: "0.10.0",
    channel: "win-installer",
    platform: "win32",
    arch: "x64",
  });
  const winBinDir = path.join(winInstallDir, "bin");

  const pathEnv = [npmBinDir, winBinDir].join(";");
  const winInstallation = detectInstallation({ frontendRoot: winTree.frontendDir, platform: "win32", arch: "x64" });
  const scan = scanPathInstallations({
    pathEnv,
    currentInstallRoot: winInstallation.installRoot,
    platform: "win32",
    arch: "x64",
  });

  assert.equal(scan.installations.length, 2);
  assert.equal(scan.activeOnPath.channel, "npm");
  assert.ok(scan.shadowedBy);
  assert.equal(scan.shadowedBy.channel, "npm");
  assert.equal(scan.shadowedBy.uninstallCommand, "npm uninstall -g @rind-ai/cli");

  const report = formatPathConflictReport(scan, winInstallation);
  assert.match(report, /Warning: PATH resolves "rind" to another installation first: v0\.9\.0 \(npm \(npm\)\)/);
  assert.match(report, /npm uninstall -g @rind-ai\/cli/);
});

test("TTL cache and promptStartupUpdate handle update, skip, and dismiss choices", async (t) => {
  const rindHome = withTempDir(t, "rind-home-");
  const base = withTempDir(t, "rind-install-");
  const npmTree = createFakeCliTree(path.join(base, "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "win32",
    arch: "x64",
  });
  const installation = detectInstallation({ frontendRoot: npmTree.frontendDir, platform: "win32", arch: "x64" });

  // Initially empty cache -> background refresh fetches 0.11.0
  const refreshed = await refreshUpdateCacheInBackground({
    installation,
    rindHome,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () =>
        String(url).includes("runtime-")
          ? { version: "0.11.0", dist: { tarball: "https://example.test/runtime.tgz" } }
          : { version: "0.11.0" },
    }),
  });
  assert.equal(refreshed.latestVersion, "0.11.0");
  assert.equal(shouldPromptStartupUpdate({ installation, rindHome, env: {} }), "0.11.0");

  // Second call within 20h TTL does not trigger network
  let networkCalls = 0;
  const cachedCall = refreshUpdateCacheInBackground({
    installation,
    rindHome,
    now: refreshed.checkedAt + UPDATE_CHECK_TTL_MS - 1000,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("should not be called");
    },
  });
  assert.equal(cachedCall, null);
  assert.equal(networkCalls, 0);

  // Interactive prompt: select 3rd option ("Skip until next version") via Down, Down, Enter
  const fakeInput = new EventEmitter();
  fakeInput.isTTY = true;
  fakeInput.setRawMode = () => {};
  fakeInput.resume = () => {};
  fakeInput.pause = () => {};
  let renderedOutput = "";
  const fakeOutput = new EventEmitter();
  fakeOutput.isTTY = true;
  fakeOutput.columns = 80;
  fakeOutput.rows = 24;
  fakeOutput.write = (chunk) => {
    renderedOutput += String(chunk);
    return true;
  };

  const promptPromise = promptStartupUpdate({
    installation,
    latestVersion: "0.11.0",
    input: fakeInput,
    output: fakeOutput,
    rindHome,
  });
  setImmediate(() => {
    fakeInput.emit("data", Buffer.from("\x1b[B")); // Down -> Skip
    fakeInput.emit("data", Buffer.from("\x1b[B")); // Down -> Skip until next version
    fakeInput.emit("data", Buffer.from("\r")); // Enter
  });

  const choice = await promptPromise;
  assert.equal(choice, "dismiss");
  assert.match(renderedOutput, /Update available · v0\.10\.0 → v0\.11\.0/);
  assert.equal(readUpdateCache(rindHome).dismissedVersion, "0.11.0");
  assert.equal(shouldPromptStartupUpdate({ installation, rindHome, env: {} }), null);

  // Once a newer version (0.12.0) is cached, prompt activates again
  writeUpdateCache({ checkedAt: Date.now(), latestVersion: "0.12.0" }, rindHome);
  assert.equal(shouldPromptStartupUpdate({ installation, rindHome, env: {} }), "0.12.0");
});

test("runUpdate executes channel-specific updates and verifies SHA256 integrity", async (t) => {
  const base = withTempDir(t);
  const rindHome = path.join(base, "home");

  // 1. Test win-installer update with SHA256 verification
  const winTree = createFakeCliTree(path.join(base, "Rind CLI"), {
    version: "0.10.0",
    channel: "win-installer",
    platform: "win32",
    arch: "x64",
  });
  const winInstallation = detectInstallation({ frontendRoot: winTree.frontendDir, platform: "win32", arch: "x64" });
  const fakeExeContent = Buffer.from("fake-inno-setup-binary-payload");
  const fakeExeSha256 = createHash("sha256").update(fakeExeContent).digest("hex");

  const manifestPayload = {
    version: "0.11.0",
    assets: [
      {
        name: "RindCLISetup-0.11.0-win-x64.exe",
        product: "cli",
        target: "windows-x64",
        bytes: fakeExeContent.length,
        sha256: fakeExeSha256,
      },
    ],
  };

  const spawnedCalls = [];
  const logs = [];
  const exitCode = await runUpdate({
    args: [],
    installation: winInstallation,
    rindHome,
    pathEnv: path.join(winTree.rootDir, "bin"),
    stdout: (line) => logs.push(line),
    stderr: (line) => logs.push(line),
    quiesceImpl: async () => {},
    fetchImpl: async (url) => {
      if (String(url).endsWith("release-manifest.json")) {
        return { ok: true, status: 200, json: async () => manifestPayload };
      }
      return {
        ok: true,
        status: 200,
        body: Readable.from([fakeExeContent]),
      };
    },
    spawnSyncImpl: (cmd, args) => {
      spawnedCalls.push({ cmd, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnedCalls.length, 1);
  assert.ok(spawnedCalls[0].cmd.endsWith("RindCLISetup-0.11.0-win-x64.exe"));
  assert.deepEqual(spawnedCalls[0].args, [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CLOSEAPPLICATIONS",
    `/DIR=${winInstallation.installRoot}`,
  ]);
  assert.ok(logs.some((line) => line.includes("Updated Rind from v0.10.0 to v0.11.0")));

  // 2. Test SHA256 mismatch rejection
  await assert.rejects(
    () =>
      downloadAndVerifyAsset(
        {
          name: "corrupted.exe",
          url: "https://example.test/corrupted.exe",
          bytes: fakeExeContent.length,
          sha256: "0".repeat(64),
        },
        path.join(base, "corrupted.exe"),
        {
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            body: Readable.from([fakeExeContent]),
          }),
        },
      ),
    /SHA256 verification failed/,
  );
  assert.equal(existsSync(path.join(base, "corrupted.exe")), false);
});

test("quiesceBackgroundServices blocks active work unless --force is passed", async () => {
  await assert.rejects(
    () =>
      quiesceBackgroundServices({
        force: false,
        connectManagementImpl: async () => null,
        connectRuntimeImpl: async () => ({
          request: async (method) => (method === "runtime/info" ? { busy: 1, attached: 0 } : {}),
          close: () => {},
        }),
        stopRuntimeImpl: async () => true,
      }),
    /Rind has active conversations or background tasks/,
  );

  let shutdownRequested = false;
  await quiesceBackgroundServices({
    force: true,
    connectManagementImpl: async () => null,
    connectRuntimeImpl: async () => ({
      request: async (method) => {
        if (method === "runtime/shutdown") shutdownRequested = true;
        return { busy: 1, attached: 0 };
      },
      close: () => {},
    }),
    stopRuntimeImpl: async () => true,
  });
  assert.equal(shutdownRequested, true);
});

test("runUpdate supports --check, npm channel update, and linux-portable atomic replacement with rollback on smoke failure", async (t) => {
  const base = withTempDir(t);
  const rindHome = path.join(base, "home");

  // 1. npm channel update
  const npmTree = createFakeCliTree(path.join(base, "npm-root", "@rind-ai", "cli"), {
    version: "0.10.0",
    channel: "npm",
    platform: "linux",
    arch: "x64",
  });
  const npmInstallation = detectInstallation({ frontendRoot: npmTree.frontendDir, platform: "linux", arch: "x64" });
  const npmSpawns = [];
  const checkLogs = [];

  await runUpdate({
    args: ["--check"],
    installation: npmInstallation,
    rindHome,
    pathEnv: "/usr/local/bin:relative/dir",
    stdout: (line) => checkLogs.push(line),
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("runtime-")
          ? { version: "0.11.0", dist: { tarball: "https://example.test/runtime.tgz" } }
          : { version: "0.11.0" },
    }),
  });
  assert.ok(checkLogs.some((line) => line.includes("Update available: v0.10.0 → v0.11.0")));

  await runUpdate({
    args: [],
    installation: npmInstallation,
    rindHome,
    pathEnv: "/usr/local/bin:relative/dir",
    stdout: () => {},
    quiesceImpl: async () => {},
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("runtime-")
          ? { version: "0.11.0", dist: { tarball: "https://example.test/runtime.tgz" } }
          : { version: "0.11.0" },
    }),
    spawnSyncImpl: (cmd, args, opts) => {
      npmSpawns.push({ cmd, args, opts });
      return { status: 0 };
    },
  });
  assert.equal(npmSpawns.length, 1);
  assert.equal(npmSpawns[0].cmd, "npm");
  assert.deepEqual(npmSpawns[0].args, ["install", "-g", "@rind-ai/cli@0.11.0", "--include=optional", "--no-fund", "--no-audit"]);
  assert.equal(npmSpawns[0].opts.cwd, os.tmpdir());
  assert.equal(npmSpawns[0].opts.env.PATH, "/usr/local/bin");

  // 2. linux-portable atomic replacement and smoke check
  const portableTree = createFakeCliTree(path.join(base, "portable-install"), {
    version: "0.10.0",
    channel: "linux-portable",
    platform: "linux",
    arch: "x64",
  });
  const portableInstallation = detectInstallation({
    frontendRoot: portableTree.frontendDir,
    platform: "linux",
    arch: "x64",
  });
  const fakeTarBytes = Buffer.from("fake-tar-gz");
  const fakeTarSha = createHash("sha256").update(fakeTarBytes).digest("hex");
  const portableManifest = {
    version: "0.11.0",
    assets: [
      {
        name: "rind-cli-0.11.0-linux-x64.tar.gz",
        product: "cli",
        target: "linux-x64",
        bytes: fakeTarBytes.length,
        sha256: fakeTarSha,
      },
    ],
  };

  // Smoke failure keeps existing installation untouched
  await assert.rejects(
    () =>
      runUpdate({
        args: [],
        installation: portableInstallation,
        rindHome,
        pathEnv: "",
        stdout: () => {},
        quiesceImpl: async () => {},
        fetchImpl: async (url) =>
          String(url).endsWith("release-manifest.json")
            ? { ok: true, status: 200, json: async () => portableManifest }
            : { ok: true, status: 200, body: Readable.from([fakeTarBytes]) },
        spawnSyncImpl: (cmd, args) => {
          if (cmd === "tar") {
            const destDir = args[args.indexOf("-C") + 1];
            createFakeCliTree(path.join(destDir, "rind-cli"), {
              version: "0.11.0",
              channel: "linux-portable",
              platform: "linux",
              arch: "x64",
            });
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "GLIBC_2.99 not found" };
        },
      }),
    /Updated runtime failed pre-activation self-check/,
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(portableTree.frontendDir, "package.json"), "utf8")).version,
    "0.10.0",
  );

  // Smoke success atomically swaps portable root to 0.11.0
  await runUpdate({
    args: [],
    installation: portableInstallation,
    rindHome,
    pathEnv: "",
    stdout: () => {},
    quiesceImpl: async () => {},
    fetchImpl: async (url) =>
      String(url).endsWith("release-manifest.json")
        ? { ok: true, status: 200, json: async () => portableManifest }
        : { ok: true, status: 200, body: Readable.from([fakeTarBytes]) },
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "tar") {
        const destDir = args[args.indexOf("-C") + 1];
        createFakeCliTree(path.join(destDir, "rind-cli"), {
          version: "0.11.0",
          channel: "linux-portable",
          platform: "linux",
          arch: "x64",
        });
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "rind 0.11.0\n", stderr: "" };
    },
  });
  assert.equal(
    JSON.parse(readFileSync(path.join(portableTree.frontendDir, "package.json"), "utf8")).version,
    "0.11.0",
  );
});
