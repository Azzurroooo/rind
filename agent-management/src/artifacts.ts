import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { requireValue, text, type Artifact } from "./model.js";
import { inside, privateDirectory } from "./paths.js";

// A delivered file is copied for its recipient: <root>/<team>/<recipient>/<task>/<id>/<name>.
// The recipient reads the copy by its path; the owner's workspace may change afterwards.
export async function publishArtifact(root: string, owner: { workspace: string }, into: { teamId: string; recipient: string; taskId: string }, file: unknown): Promise<Artifact> {
  const source = await realpath(path.resolve(owner.workspace, text(file, "Artifact path", 4000))).catch(() => "");
  requireValue(source && inside(owner.workspace, source) && (await stat(source)).isFile(), "INVALID_ARTIFACT", "An artifact must be a file inside your workspace: " + String(file));
  const id = randomUUID();
  const relative = path.join(into.teamId, into.recipient, into.taskId, id, path.basename(source));
  const output = path.join(root, relative);
  await privateDirectory(path.dirname(output));
  await copyFile(source, output, constants.COPYFILE_EXCL);
  if (process.platform !== "win32") await chmod(output, 0o600);
  const hash = createHash("sha256");
  for await (const data of createReadStream(output)) hash.update(data);
  return { id, taskId: into.taskId, name: path.basename(source), file: relative, size: (await stat(output)).size, sha256: hash.digest("hex") };
}
