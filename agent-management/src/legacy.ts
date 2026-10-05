import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { inside } from "./paths.js";
import { requireValue } from "./model.js";

export async function previewLegacyTeam(rootPath: string) {
  const root = await realpath(rootPath);
  const project = parse(await readFile(path.join(root, ".aiteam", "project.yaml"), "utf8"));
  requireValue(project?.kind === "Project", "INVALID_LEGACY_TEAM", "Expected an aiteam/v1 Project.");
  const agentsRoot = await realpath(path.resolve(root, ".aiteam", project.spec?.agents_root || "../agents"));
  requireValue(inside(root, agentsRoot), "INVALID_LEGACY_TEAM", "Legacy agents directory must stay inside the project.");
  const agents = []; const errors: string[] = [];
  for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspace = await realpath(path.join(agentsRoot, entry.name));
    try {
      requireValue(inside(agentsRoot, workspace), "INVALID_LEGACY_TEAM", "Legacy member escapes its project.");
      const manifestRoot = path.join(workspace, ".aiteam");
      const manifest = parse(await readFile(path.join(manifestRoot, "agent.yaml"), "utf8"));
      requireValue(manifest?.kind === "Agent", "INVALID_LEGACY_TEAM", "Expected an Agent manifest.");
      const promptParts = [];
      for (const reference of manifest.spec?.prompts?.system || []) {
        const source = await realpath(path.resolve(manifestRoot, reference));
        requireValue(inside(workspace, source), "INVALID_LEGACY_TEAM", "Prompt references a file outside its member workspace.");
        promptParts.push(await readFile(source, "utf8"));
      }
      const skillRefs = [];
      for (const name of manifest.spec?.skills?.enabled || []) {
        const candidate = path.join(manifestRoot, "skills", name, "SKILL.md");
        try {
          const source = await realpath(candidate);
          requireValue(inside(workspace, source), "INVALID_LEGACY_TEAM", "Skill references a file outside its member workspace.");
          skillRefs.push(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          skillRefs.push(name);
        }
      }
      agents.push({ legacyId: entry.name, name: manifest.metadata?.name || entry.name, workspace, hint: promptParts.join("\n"), skillRefs, responsibility: manifest.metadata?.description || "" });
    } catch (error) { errors.push(entry.name + ": " + String(error)); }
  }
  requireValue(agents.some(a => a.legacyId === project.spec?.main_agent), "INVALID_LEGACY_TEAM", "Legacy leader is missing or invalid.");
  const result = { root, name: project.metadata?.name || path.basename(root), leader: project.spec.main_agent as string, agents, errors };
  return { ...result, fingerprint: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
