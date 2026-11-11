import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RIND_DOC_BYTE_LIMIT,
  buildRindDocContext,
  canonicalizePath,
  resolveProjectDocPath,
  resolveProjectRoot,
  resolveUserDocPath,
} from "../dist/index.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(TEST_DIR, "..");
const PROJECT_ROOT = path.resolve(RUNTIME_ROOT, "..");
const SRC_ROOT = path.join(RUNTIME_ROOT, "src");

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out.sort();
}

function parseModuleSpecifiers(tsSource) {
  const specs = new Set();
  const sideEffectImportRe = /^\s*import\s+["']([^"']+)["']/gm;
  const fromImportExportRe = /^\s*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))?)\s+from\s+["']([^"']+)["']/gm;
  const dynamicImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of tsSource.matchAll(sideEffectImportRe)) {
    specs.add(match[1]);
  }
  for (const match of tsSource.matchAll(fromImportExportRe)) {
    specs.add(match[1]);
  }
  for (const match of tsSource.matchAll(dynamicImportRe)) {
    specs.add(match[1]);
  }
  return [...specs];
}

function resolveInternalTsTarget(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const raw = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/, ".ts"),
    path.join(raw, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function relPosix(base, target) {
  return path.relative(base, target).replace(/\\/g, "/");
}

test("TypeScript runtime layer dependencies point inward and prompts stay pure", () => {
  const tsFiles = walkFiles(SRC_ROOT, f => f.endsWith(".ts"));
  const violations = [];

  for (const file of tsFiles) {
    const rel = relPosix(SRC_ROOT, file);
    const topLayer = rel.includes("/") ? rel.split("/")[0] : rel;
    const specs = parseModuleSpecifiers(fs.readFileSync(file, "utf8"));

    if (rel === "prompts.ts") {
      for (const spec of specs) {
        if (
          spec === "node:os" ||
          spec === "os" ||
          spec === "node:child_process" ||
          spec === "child_process"
        ) {
          violations.push(`${rel} -> ${spec}`);
        }
        const target = resolveInternalTsTarget(file, spec);
        if (target) {
          const targetRel = relPosix(SRC_ROOT, target);
          if (!targetRel.startsWith("domain/") && targetRel !== "prompts.ts") {
            violations.push(`${rel} -> ${targetRel}`);
          }
        }
      }
      continue;
    }

    for (const spec of specs) {
      const target = resolveInternalTsTarget(file, spec);
      if (!target) continue;
      const targetRel = relPosix(SRC_ROOT, target);
      const targetLayer = targetRel.includes("/") ? targetRel.split("/")[0] : targetRel;

      if (topLayer === "domain" && targetLayer !== "domain") {
        violations.push(`${rel} -> ${targetRel}`);
      } else if (
        topLayer === "infrastructure" &&
        ["application", "core", "server", "gateway", "cli.ts", "index.ts"].includes(targetLayer)
      ) {
        violations.push(`${rel} -> ${targetRel}`);
      } else if (
        topLayer === "application" &&
        ["core", "server", "gateway", "cli.ts", "index.ts"].includes(targetLayer)
      ) {
        violations.push(`${rel} -> ${targetRel}`);
      } else if (
        topLayer === "core" &&
        ["server", "gateway", "cli.ts", "index.ts"].includes(targetLayer)
      ) {
        violations.push(`${rel} -> ${targetRel}`);
      } else if (
        topLayer === "server" &&
        ["gateway", "cli.ts", "index.ts"].includes(targetLayer)
      ) {
        violations.push(`${rel} -> ${targetRel}`);
      } else if (
        topLayer === "gateway" &&
        ["cli.ts", "index.ts"].includes(targetLayer)
      ) {
        violations.push(`${rel} -> ${targetRel}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Invalid layer dependencies:\n${violations.join("\n")}`);
});

test("runtime entrypoints use shared composition root and module graph has no cycles", () => {
  const executionSource = fs.readFileSync(path.join(SRC_ROOT, "server", "execution.ts"), "utf8");
  assert.match(executionSource, /\bbuildAgentContainer\s*\(/);

  const cliSource = fs.readFileSync(path.join(SRC_ROOT, "cli.ts"), "utf8");
  assert.match(cliSource, /\bappServerMain\b/);
  assert.doesNotMatch(cliSource, /\bbuildAgentContainer\b/);

  const tsFiles = walkFiles(SRC_ROOT, f => f.endsWith(".ts"));
  const edges = new Map();
  for (const file of tsFiles) {
    const rel = relPosix(SRC_ROOT, file);
    const targets = new Set();
    for (const spec of parseModuleSpecifiers(fs.readFileSync(file, "utf8"))) {
      const target = resolveInternalTsTarget(file, spec);
      if (target) {
        const targetRel = relPosix(SRC_ROOT, target);
        if (targetRel !== rel) targets.add(targetRel);
      }
    }
    edges.set(rel, [...targets].sort());
  }

  const visited = new Set();
  const visiting = [];

  function visit(node) {
    assert.ok(
      !visiting.includes(node),
      `Dependency cycle detected: ${[...visiting, node].join(" -> ")}`,
    );
    if (visited.has(node)) return;
    visiting.push(node);
    for (const next of edges.get(node) || []) {
      visit(next);
    }
    visiting.pop();
    visited.add(node);
  }

  for (const node of [...edges.keys()].sort()) {
    visit(node);
  }
});

test("all third-party imports in runtime/src are declared in runtime/package.json dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_ROOT, "package.json"), "utf8"));
  const declared = new Set(Object.keys(pkg.dependencies || {}));
  const nodeBuiltins = new Set(
    builtinModules.flatMap(m => (m.startsWith("node:") ? [m, m.slice(5)] : [m, `node:${m}`])),
  );

  const undeclared = [];
  for (const file of walkFiles(SRC_ROOT, f => f.endsWith(".ts"))) {
    const rel = relPosix(PROJECT_ROOT, file);
    for (const spec of parseModuleSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("/") || nodeBuiltins.has(spec)) {
        continue;
      }
      const pkgName = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (!declared.has(pkgName)) {
        undeclared.push(`${rel}: ${pkgName}`);
      }
    }
  }

  assert.deepEqual(
    undeclared,
    [],
    `Undeclared runtime third-party imports:\n${undeclared.join("\n")}`,
  );
});

test("RIND.md context injects user before project, skips missing levels, truncates UTF-8 cleanly, and uses cwd", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-docs-contract-"));
  const userHome = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const nested = path.join(project, "src");
  await mkdir(userHome, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = userHome;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  // 1. Absent docs inject nothing
  {
    const [messages, stats, decisions] = buildRindDocContext(project);
    assert.deepEqual(messages, []);
    assert.equal(stats.rind_docs_user_exists, false);
    assert.equal(stats.rind_docs_project_exists, false);
    assert.equal(decisions.rind_docs_injected, false);
  }

  // 2. Project-only skips missing user level
  await writeFile(path.join(project, "RIND.md"), "project guidance", "utf8");
  {
    const [messages, stats, decisions] = buildRindDocContext(project);
    const content = String(messages[0].content);
    assert.equal(content.includes("--- user-doc ---"), false);
    assert.equal(content.startsWith("\n\n--- project-doc ---\n\n"), true);
    assert.equal(content.includes("project guidance"), true);
    assert.equal(stats.rind_docs_user_exists, false);
    assert.equal(decisions.rind_docs_injected, true);
  }

  // 3. User doc injected before project doc
  await writeFile(path.join(userHome, "RIND.md"), "user guidance", "utf8");
  {
    const [messages, stats, decisions] = buildRindDocContext(project);
    const content = String(messages[0].content);
    assert.ok(content.indexOf("--- user-doc ---") < content.indexOf("--- project-doc ---"));
    assert.equal(content.includes("user guidance"), true);
    assert.equal(content.includes("project guidance"), true);
    assert.equal(stats.rind_docs_user_exists, true);
    assert.equal(stats.rind_docs_project_exists, true);
    assert.equal(decisions.rind_docs_truncated, false);
  }

  // 4. UTF-8 byte boundary truncation produces no replacement char
  const raw = Buffer.concat([
    Buffer.alloc(RIND_DOC_BYTE_LIMIT - 1, "a"),
    Buffer.from("你", "utf8"),
  ]);
  await writeFile(path.join(userHome, "RIND.md"), raw);
  {
    const [messages, stats, decisions] = buildRindDocContext(project);
    const content = String(messages[0].content);
    assert.equal(content.includes("was truncated before injection"), true);
    assert.equal(content.includes("\ufffd"), false);
    assert.equal(stats.rind_docs_user_bytes, raw.byteLength);
    assert.ok(Number(stats.rind_docs_user_injected_bytes) <= RIND_DOC_BYTE_LIMIT);
    assert.equal(decisions.rind_docs_truncated, true);
    assert.deepEqual(decisions.rind_docs_truncated_scopes, ["user"]);
  }

  // 5. Uses cwd rather than walking up to parent .git root
  await rm(path.join(userHome, "RIND.md"), { force: true });
  await writeFile(path.join(project, "RIND.md"), "parent git root doc", "utf8");
  await writeFile(path.join(nested, "RIND.md"), "cwd doc", "utf8");
  {
    assert.equal(resolveUserDocPath(), path.join(canonicalizePath(userHome), "RIND.md"));
    assert.equal(resolveProjectDocPath(nested), path.join(resolveProjectRoot(nested), "RIND.md"));
    const [messages] = buildRindDocContext(nested);
    const content = String(messages[0].content);
    assert.equal(content.includes("cwd doc"), true);
    assert.equal(content.includes("parent git root doc"), false);
  }
});

test("docs/internals maintains bilingual .zh-CN.md pairs and valid relative Markdown links", () => {
  const internalsRoot = path.join(PROJECT_ROOT, "docs", "internals");
  assert.equal(fs.existsSync(internalsRoot) && fs.statSync(internalsRoot).isDirectory(), true);

  const allMdFiles = walkFiles(internalsRoot, f => f.endsWith(".md"));
  assert.ok(allMdFiles.length > 0, "Expected markdown files under docs/internals");

  const missingZh = [];
  const missingEn = [];
  for (const mdPath of allMdFiles) {
    const base = path.basename(mdPath);
    const dir = path.dirname(mdPath);
    if (base.endsWith(".zh-CN.md")) {
      const enPath = path.join(dir, `${base.slice(0, -".zh-CN.md".length)}.md`);
      if (!fs.existsSync(enPath)) {
        missingEn.push(relPosix(PROJECT_ROOT, mdPath));
      }
    } else {
      const stem = base.slice(0, -".md".length);
      const zhPath = path.join(dir, `${stem}.zh-CN.md`);
      if (!fs.existsSync(zhPath)) {
        missingZh.push(relPosix(PROJECT_ROOT, mdPath));
      }
    }
  }

  assert.deepEqual(missingZh, [], `Missing matching .zh-CN.md files:\n${missingZh.join("\n")}`);
  assert.deepEqual(missingEn, [], `Missing matching English .md files:\n${missingEn.join("\n")}`);

  const filesToCheck = [
    ...allMdFiles,
    path.join(PROJECT_ROOT, "README.md"),
    path.join(PROJECT_ROOT, "README.zh-CN.md"),
    path.join(PROJECT_ROOT, "CONTRIBUTING.md"),
  ].filter(f => fs.existsSync(f));

  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const brokenLinks = [];
  for (const mdPath of filesToCheck) {
    const content = fs.readFileSync(mdPath, "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const target = match[2].trim();
      if (
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:") ||
        target.startsWith("#")
      ) {
        continue;
      }
      const fileTarget = target.split("#", 1)[0];
      if (!fileTarget) continue;
      const resolved = path.resolve(path.dirname(mdPath), fileTarget);
      if (!fs.existsSync(resolved)) {
        brokenLinks.push(
          `${relPosix(PROJECT_ROOT, mdPath)}: [${match[1]}](${target}) -> ${resolved}`,
        );
      }
    }
  }

  assert.deepEqual(
    brokenLinks,
    [],
    `Broken relative links found:\n${brokenLinks.join("\n")}`,
  );
});
