import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { listProjectFiles, previewProjectFile } from "../src/main/project-files.ts"

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "rind-desktop-files-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

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
