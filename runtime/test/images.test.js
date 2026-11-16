import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CancellationTokenSource,
  CancelledError,
  ProviderError,
  ToolResultNormalizer,
  buildAgentContainer,
  captureImage,
  loadImage,
  loadPhotonSync,
  loadSettings,
  prepareImageMessages,
  processImage,
  processImageAsync,
  readFile,
  renderResumePreview,
} from "../dist/index.js";

function makeRgbaPixels(width, height, r = 10, g = 40, b = 220, a = 255) {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

function encodePngBytes(width, height, rgba = makeRgbaPixels(width, height)) {
  const photon = loadPhotonSync();
  const img = new photon.PhotonImage(rgba, width, height);
  try {
    return Buffer.from(img.get_bytes());
  } finally {
    img.free();
  }
}

function encodeJpegBytes(width, height, quality = 85, rgba = makeRgbaPixels(width, height)) {
  const photon = loadPhotonSync();
  const img = new photon.PhotonImage(rgba, width, height);
  try {
    return Buffer.from(img.get_bytes_jpeg(quality));
  } finally {
    img.free();
  }
}

function encodeWebpBytes(width, height, rgba = makeRgbaPixels(width, height)) {
  const photon = loadPhotonSync();
  const img = new photon.PhotonImage(rgba, width, height);
  try {
    return Buffer.from(img.get_bytes_webp());
  } finally {
    img.free();
  }
}

function encodeBmp24Bytes(width, height, bgr = [220, 40, 10]) {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    const rowStart = 54 + y * rowStride;
    for (let x = 0; x < width; x += 1) {
      const idx = rowStart + x * 3;
      buf[idx] = bgr[0];
      buf[idx + 1] = bgr[1];
      buf[idx + 2] = bgr[2];
    }
  }
  return buf;
}

// Minimal valid LZW encoder for 2-color (minCodeSize = 2) solid-fill GIF frames
function encodeGif89a(width, height, frames = 1) {
  const header = Buffer.alloc(13 + 6);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80; // GCT flag, 2 colors (2^(0+1))
  header[11] = 0;
  header[12] = 0;
  // Color 0: blue (10, 40, 220), Color 1: white
  header[13] = 10;
  header[14] = 40;
  header[15] = 220;
  header[16] = 255;
  header[17] = 255;
  header[18] = 255;

  // LZW stream using clear codes (4) every ~100 pixels so code width stays 3 bits
  const minCodeSize = 2;
  const CLEAR = 4;
  const EOI = 5;
  const totalPixels = width * height;
  const codes = [CLEAR];
  for (let i = 0; i < totalPixels; i += 1) {
    codes.push(0);
    // Reset dictionary before 3-bit table fills (codes 4,5 + 2 entries -> max 7)
    codes.push(CLEAR);
  }
  codes.push(EOI);

  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;
  for (const code of codes) {
    bitBuf |= code << bitCount;
    bitCount += 3;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) {
    bytes.push(bitBuf & 0xff);
  }

  const subBlocks = [Buffer.from([minCodeSize])];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const slice = bytes.slice(offset, offset + 255);
    subBlocks.push(Buffer.from([slice.length, ...slice]));
  }
  subBlocks.push(Buffer.from([0x00]));

  const imgDesc = Buffer.alloc(10);
  imgDesc[0] = 0x2c;
  imgDesc.writeUInt16LE(0, 1);
  imgDesc.writeUInt16LE(0, 3);
  imgDesc.writeUInt16LE(width, 5);
  imgDesc.writeUInt16LE(height, 7);
  imgDesc[9] = 0x00;

  const singleFrame = Buffer.concat([imgDesc, ...subBlocks]);
  const parts = [header];
  for (let f = 0; f < frames; f += 1) {
    parts.push(singleFrame);
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function injectJpegExifOrientation(jpegBytes, orientation) {
  // APP1 segment: FF E1 <len:2> "Exif\0\0" "II" 0x002A <ifdOffset=8:4> <count=1:2> <tag=0x0112:2,type=3:2,cnt=1:4,val:2,pad:2> <nextIfd=0:4>
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const segLen = 2 + exifHeader.length + tiff.length;
  const app1 = Buffer.alloc(2 + 2);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(segLen, 2);

  return Buffer.concat([jpegBytes.subarray(0, 2), app1, exifHeader, tiff, jpegBytes.subarray(2)]);
}

test("processImage decodes and downscales PNG, JPEG, WEBP, GIF, and BMP > 2000px", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-images-fmt-"));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const builders = [
    ["PNG", () => encodePngBytes(2100, 100)],
    ["JPEG", () => encodeJpegBytes(2100, 100)],
    ["WEBP", () => encodeWebpBytes(2100, 100)],
    ["GIF", () => encodeGif89a(2100, 40, 1)],
    ["BMP", () => encodeBmp24Bytes(2100, 100)],
  ];

  for (const [format, build] of builders) {
    const source = path.join(tmp, `misnamed-${format}.txt`);
    await writeFile(source, build());
    const result = processImage(source);
    assert.equal(result.width, 2000, `${format} width should scale to 2000`);
    assert.ok(result.height < 100, `${format} height should scale proportionally`);
    assert.ok(
      result.mime === "image/png" || result.mime === "image/jpeg",
      `${format} normalized mime ${result.mime}`,
    );
    assert.ok(result.data.length < 3 * 1024 * 1024);
    assert.match(result.hint, /Original 2100x/);
  }
});

test("processImage detects animated GIF first frame, corrects EXIF orientation, and compresses >3MiB noise", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-images-meta-"));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // 1. Animated 2-frame GIF
  const animPath = path.join(tmp, "anim.gif");
  await writeFile(animPath, encodeGif89a(16, 16, 2));
  const animRes = processImage(animPath);
  assert.equal(animRes.mime, "image/png");
  assert.match(animRes.hint, /First frame only\./);

  // 2. EXIF Orientation 6 (90° CW): 120x60 -> 60x120
  const rawJpg = encodeJpegBytes(120, 60, 90);
  const exifPath = path.join(tmp, "rotated.jpg");
  await writeFile(exifPath, injectJpegExifOrientation(rawJpg, 6));
  const exifRes = processImage(exifPath);
  assert.equal(exifRes.width, 60);
  assert.equal(exifRes.height, 120);
  assert.match(exifRes.hint, /EXIF orientation corrected\./);

  // 3. High-entropy > 3 MiB PNG (1900x1900 pseudo-random RGB opaque) steps down to JPEG <= 3 MiB
  const w = 1900;
  const h = 1900;
  const noisy = new Uint8Array(w * h * 4);
  let seed = 0x12345678;
  for (let i = 0; i < noisy.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noisy[i] = seed & 0xff;
    noisy[i + 1] = (seed >>> 8) & 0xff;
    noisy[i + 2] = (seed >>> 16) & 0xff;
    noisy[i + 3] = 255;
  }
  // Write as uncompressed 24-bit BMP (~10.8 MiB, between 3 MiB and 20 MiB!)
  const rowStride = Math.ceil((w * 3) / 4) * 4;
  const bmpBuf = Buffer.alloc(54 + rowStride * h);
  bmpBuf.write("BM", 0, "ascii");
  bmpBuf.writeUInt32LE(bmpBuf.length, 2);
  bmpBuf.writeUInt32LE(54, 10);
  bmpBuf.writeUInt32LE(40, 14);
  bmpBuf.writeInt32LE(w, 18);
  bmpBuf.writeInt32LE(h, 22);
  bmpBuf.writeUInt16LE(1, 26);
  bmpBuf.writeUInt16LE(24, 28);
  bmpBuf.writeUInt32LE(rowStride * h, 34);
  for (let y = 0; y < h; y += 1) {
    const rOff = 54 + y * rowStride;
    for (let x = 0; x < w; x += 1) {
      const pIdx = (y * w + x) * 4;
      const bIdx = rOff + x * 3;
      bmpBuf[bIdx] = noisy[pIdx];
      bmpBuf[bIdx + 1] = noisy[pIdx + 1];
      bmpBuf[bIdx + 2] = noisy[pIdx + 2];
    }
  }
  const noisyPath = path.join(tmp, "large-noisy.bmp");
  await writeFile(noisyPath, bmpBuf);
  assert.ok(fs.statSync(noisyPath).size > 10 * 1024 * 1024);

  const compressed = processImage(noisyPath);
  assert.ok(compressed.data.length <= 3 * 1024 * 1024);
  assert.equal(compressed.mime, "image/jpeg");
  assert.match(compressed.hint, /Reduced to \d+x\d+ to fit the image limit\./);
});

test("processImage and processImageAsync reject invalid, unsupported, oversized, and cancelled inputs", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-images-err-"));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // Corrupt PNG signature with garbage body
  const badPng = path.join(tmp, "bad.png");
  await writeFile(badPng, Buffer.from("\x89PNG\r\n\x1a\n-not-a-real-image", "binary"));
  assert.throws(
    () => processImage(badPng),
    err => err instanceof ProviderError && err.code === "InvalidImage" && /decoded/i.test(err.message),
  );

  // Valid PNG signature + IHDR chunk, but invalid IDAT payload -> caught by Photon WASM decode
  const fakeIhdr = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakeIhdr, 0);
  fakeIhdr.writeUInt32BE(13, 8);
  fakeIhdr.write("IHDR", 12, "ascii");
  fakeIhdr.writeUInt32BE(10, 16);
  fakeIhdr.writeUInt32BE(10, 20);
  fakeIhdr[24] = 8;
  fakeIhdr[25] = 2;
  const badIdat = path.join(tmp, "bad-idat.png");
  await writeFile(badIdat, fakeIhdr);
  assert.throws(
    () => processImage(badIdat),
    err => err instanceof ProviderError && err.code === "InvalidImage",
  );

  // Unsupported format
  const plainTxt = path.join(tmp, "hello.bin");
  await writeFile(plainTxt, "just plain text, not an image");
  assert.throws(
    () => processImage(plainTxt),
    err => err instanceof ProviderError && err.code === "UnsupportedImage",
  );

  // Pixel bomb (> 40M pixels in header)
  const bombPng = Buffer.from(fakeIhdr);
  bombPng.writeUInt32BE(10_000, 16);
  bombPng.writeUInt32BE(5_000, 20);
  const bombPath = path.join(tmp, "bomb.png");
  await writeFile(bombPath, bombPng);
  assert.throws(
    () => processImage(bombPath),
    err => err instanceof ProviderError && err.code === "ImageTooLarge" && /40 million/.test(err.message),
  );

  // Worker-thread processImageAsync + CancellationToken
  const goodPath = path.join(tmp, "good.png");
  await writeFile(goodPath, encodePngBytes(32, 24));
  const asyncDecoded = await processImageAsync(goodPath);
  assert.equal(asyncDecoded.width, 32);
  assert.equal(asyncDecoded.height, 24);

  const cts = new CancellationTokenSource();
  cts.cancel("stop");
  assert.throws(() => processImage(goodPath, cts.token), err => err instanceof CancelledError);
  await assert.rejects(() => processImageAsync(goodPath, cts.token), err => err instanceof CancelledError);
});

test("captureImage reuses snapshots, verifies SHA-256 integrity, and wires read_file attachments", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-images-cap-"));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const source = path.join(tmp, "original.png");
  await writeFile(source, encodePngBytes(16, 12, makeRgbaPixels(16, 12, 1, 2, 3, 4)));
  const sessionBase = path.join(tmp, "session");
  await mkdir(sessionBase, { recursive: true });

  const [ref, note] = captureImage(sessionBase, source);
  assert.equal(note, "");
  const before = loadImage(sessionBase, ref);
  await rm(source);

  const [second] = captureImage(sessionBase, path.join(sessionBase, ref.path));
  assert.deepEqual(second, ref);
  assert.deepEqual(loadImage(sessionBase, second), before);

  // Tampering triggers AttachmentUnavailable
  await writeFile(path.join(sessionBase, ref.path), "tampered");
  assert.throws(
    () => loadImage(sessionBase, ref),
    err => err instanceof ProviderError && /missing or damaged/.test(err.message),
  );

  // read_file tool normalizes attachments outside text budget
  const img2 = path.join(tmp, "image.png");
  await writeFile(img2, encodePngBytes(12, 10));
  const sessionBase2 = path.join(tmp, "session2");
  await mkdir(sessionBase2, { recursive: true });

  const rawRead = await readFile(img2, 1, 1000, null, {
    captureImage: (p, tok) => captureImage(sessionBase2, p, tok),
    imageInput: true,
  });
  const normalized = await new ToolResultNormalizer().normalize(rawRead, { toolName: "read_file" });
  assert.equal(normalized.attachments.length, 1);
  assert.ok(!("attachments" in JSON.parse(normalized.model_content)));
  assert.match(normalized.terminal_content, /Read image/);

  const unsupported = JSON.parse(await readFile(img2, 1, 1000, null, { imageInput: false }));
  assert.equal(unsupported.error_type, "ImageInputUnsupported");
  const badPage = JSON.parse(await readFile(img2, 2, 1000, null, { imageInput: true }));
  assert.equal(badPage.error_type, "InvalidImagePagination");
});

test("old image budget triggers single compaction and legacy uploads render notice", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rind-images-budget-"));
  const prevHome = process.env.RIND_HOME;
  process.env.RIND_HOME = path.join(tmp, "home");
  t.after(async () => {
    if (prevHome === undefined) delete process.env.RIND_HOME;
    else process.env.RIND_HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  // Legacy resume preview check
  const oldMsg = [{ role: "user", content: "uploads/old.png" }];
  assert.match(renderResumePreview(oldMsg), /no image snapshot/);
  assert.doesNotMatch(renderResumePreview([{ ...oldMsg[0], attachments: [] }]), /no image snapshot/);

  // 9 historical images -> compacts once to fit <= 8 image budget
  let createCalls = 0;
  const streamRequests = [];
  const fakeClient = {
    model: "fake-vision-model",
    async create() {
      createCalls += 1;
      return {
        content: "Prior image observations retained.",
        tool_calls: [],
        usage: null,
      };
    },
    async *stream(messages) {
      streamRequests.push(messages);
      yield { type: "text_delta", text: "done" };
      yield { type: "completed", stop_reason: "stop" };
    },
  };

  const settings = loadSettings(path.join(tmp, "settings.json"));
  const container = buildAgentContainer({
    settings,
    chatClient: fakeClient,
    imageInput: true,
    sessionDir: path.join(tmp, "sessions"),
    workspaceRoot: tmp,
  });

  try {
    await container.runtime.initialize();
    const store = container.session_store;
    await store.persist_user_input("start");
    const imgPath = path.join(tmp, "sample.png");
    await writeFile(imgPath, encodePngBytes(8, 8));
    const [ref] = store.captureImage(imgPath);

    for (let i = 0; i < 9; i += 1) {
      await store.persist_message("user", `Image ${i}`, null, null, null, null, [ref]);
      await store.persist_message("assistant", "seen");
    }

    const events = [];
    for await (const ev of container.runtime.runTurn({ query: "continue" })) {
      events.push(ev);
    }
    assert.equal(events.at(-1)?.type, "turn_completed");
    assert.equal(createCalls, 1);
    assert.equal(streamRequests.length, 1);
    const sentImages = streamRequests[0].reduce(
      (sum, m) => sum + (Array.isArray(m.images) ? m.images.length : 0),
      0,
    );
    assert.ok(sentImages <= 8, `Expected <= 8 images after compaction, got ${sentImages}`);
  } finally {
    container.shell_tools.closeNow();
    container.web_sessions.close();
  }
});
