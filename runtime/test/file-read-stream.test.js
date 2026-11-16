import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "../dist/infrastructure/tools/file-tools.js";
import { CancellationTokenSource } from "../dist/domain/cancellation.js";

test("paged reads preserve line endings, UTF-8 validation and bounded reads", async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rind-page-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "text.txt");
  const source = 'a'.repeat(65535) + '\r\n中文😀\rthree\nfour';
  await fs.promises.writeFile(file, source);
  const result = JSON.parse(await readFile(file, 2, 2));
  assert.equal(result.ok, true);
  assert.equal(result.meta.next_offset, 4);
  assert.match(result.data, /2 \| 中文😀\n\s*3 \| three/);
  assert.equal(JSON.parse(await readFile(file, 1, 1)).error_type, "LineTooLong");
  assert.equal(JSON.parse(await readFile(file, 5, 1)).error_type, "OffsetOutOfRange");
  await fs.promises.appendFile(file, Buffer.from([0xff]));
  assert.equal(JSON.parse(await readFile(file, 2, 1)).error_type, "InvalidEncoding");
  for (const text of ['', '\n', '\r', '\r\n', '\ufeff中\r\n末尾', '中文😀\n'.repeat(15000)]) {
    await fs.promises.writeFile(file, text);
    const page = JSON.parse(await readFile(file, 1, 2));
    assert.equal(page.ok, true);
    assert.equal(page.meta.next_offset, text.includes('末尾') || text.length < 10 ? null : 3);
  }
});

test("large reads remain cancellable and never use whole-file readFileSync", async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rind-page-cancel-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.txt");
  await fs.promises.writeFile(file, 'a\n'.repeat(4 * 1024 * 1024));
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (...args) {
    assert.notEqual(args[0], file);
    return original.apply(this, args);
  });
  const source = new CancellationTokenSource();
  const promise = readFile(file, 1, 1, source.token);
  setImmediate(() => source.cancel("stop"));
  assert.equal(JSON.parse(await promise).ok, false);
  const page = JSON.parse(await readFile(file, 1, 1));
  assert.equal(page.meta.next_offset, 2);
  assert.match(page.data, /1 \| a$/);
});
