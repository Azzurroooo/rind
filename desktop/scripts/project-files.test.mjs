import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { listProjectFiles, previewProjectFile } from "../../rind-runtime-client/remote/files.js"

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "rind-desktop-files-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("UTF-8 previews truncate only incomplete boundary characters, not valid files", async () => {
  await withTempDirectory(async directory => {
    for (const suffix of ["中文", "😀end"]) {
      await writeFile(join(directory, "boundary.txt"), "a".repeat(999999) + suffix);
      const result = await previewProjectFile(directory, "boundary.txt");
      assert.equal(result.kind, "text");
      assert.equal(result.truncated, true);
      assert.equal(result.content, "a".repeat(999999));
    }
    await writeFile(join(directory, "invalid.txt"), Buffer.from([0x61, 0xe4, 0xb8]));
    assert.equal((await previewProjectFile(directory, "invalid.txt")).kind, "unsupported");
    await writeFile(join(directory, "exact.txt"), "a".repeat(999997) + "中");
    const exact = await previewProjectFile(directory, "exact.txt");
    assert.equal(exact.kind, "text");
    assert.equal(exact.truncated, false);
    assert.ok(exact.content.endsWith("中"));
  });
});

test("project file browsing keeps paths inside the active project", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "project")
    const outside = join(directory, "outside.txt")
    await mkdir(join(root, "src"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "README.md"), "Hello Rind\n", "utf8"),
      writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71])),
      writeFile(outside, "private", "utf8"),
    ])

    const listing = await listProjectFiles(root, "")
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["src", "image.png", "README.md"])

    const text = await previewProjectFile(root, "README.md")
    assert.equal(text.kind, "text")
    assert.equal(text.content, "Hello Rind\n")

    const image = await previewProjectFile(root, "image.png")
    assert.equal(image.kind, "image")
    assert.match(image.dataUrl, /^data:image\/png;base64,/)

    await assert.rejects(() => listProjectFiles(root, "../"), /cannot leave the active project/)
    await assert.rejects(() => previewProjectFile(root, "../outside.txt"), /cannot leave the active project/)
  })
})
