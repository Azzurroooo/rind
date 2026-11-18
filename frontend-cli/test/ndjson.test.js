import test from "node:test";
import assert from "node:assert/strict";
import { createLineBuffer } from "../../runtime/dist/client/ndjson.js";

test("NDJSON limits individual UTF-8 frames regardless of chunk boundaries", () => {
  const input = Buffer.from('中文\r\naa\nbb\n😀\n');
  for (let size = 1; size <= input.length; size++) {
    const lines = [];
    let overflows = 0;
    const buffer = createLineBuffer(line => lines.push(line), { maxBytes: 7, onOverflow: () => overflows++ });
    for (let i = 0; i < input.length; i += size) assert.equal(buffer.push(input.subarray(i, i + size)), true);
    assert.deepEqual(lines, ['中文', 'aa', 'bb', '😀']);
    assert.equal(overflows, 0);
  }
});

test("NDJSON rejects oversized UTF-8 frames and stays failed until reset", () => {
  const lines = [];
  let overflows = 0;
  const buffer = createLineBuffer(line => lines.push(line), { maxBytes: 6, onOverflow: () => overflows++ });
  assert.equal(buffer.push('中文'), true);
  assert.equal(buffer.push('中\nignored\n'), false);
  assert.equal(buffer.push('tail\n'), false);
  assert.deepEqual(lines, []);
  assert.equal(overflows, 1);
  buffer.reset();
  assert.equal(buffer.push('aa\nbb\ncc\n'), true);
  assert.deepEqual(lines, ['aa', 'bb', 'cc']);
});
