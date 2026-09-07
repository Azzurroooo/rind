import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToDataUrl,
  composeMessageWithAttachments,
  decodeBase64ToText,
  fileToBase64,
  formatBytes,
  isImageMime,
  isTextMime,
  sanitizeFileName,
  uploadTargetPath,
  uploadTimestamp,
} from "./files.js";

describe("upload path (file/write contract: uploads/ subtree only)", () => {
  it("builds uploads/web/<yyyymmdd-hhmmss>-<name> paths", () => {
    const path = uploadTargetPath("screenshot.png", new Date(2026, 0, 2, 3, 4, 5));
    expect(path).toBe("uploads/web/20260102-030405-screenshot.png");
  });

  it("sanitizes hostile names but keeps the extension", () => {
    expect(sanitizeFileName("my report (v2).png")).toBe("my-report-v2.png");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("a".repeat(200) + ".txt")).toBe(`${"a".repeat(60)}.txt`);
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("no-ext")).toBe("no-ext");
  });

  it("formats the timestamp as yyyymmdd-hhmmss", () => {
    expect(uploadTimestamp(new Date(2026, 11, 31, 23, 59, 9))).toBe("20261231-235909");
  });
});

describe("base64 helpers (file/read + file/write payloads)", () => {
  it("round-trips bytes through base64", () => {
    const buffer = new TextEncoder().encode("Hello rind").buffer;
    const base64 = arrayBufferToBase64(buffer);
    expect(base64).toBe(btoa("Hello rind"));
    expect(decodeBase64ToText(base64)).toBe("Hello rind");
  });

  it("decodes multi-byte UTF-8 text", () => {
    const base64 = arrayBufferToBase64(new TextEncoder().encode("附件测试").buffer);
    expect(decodeBase64ToText(base64)).toBe("附件测试");
  });

  it("reads File objects via arrayBuffer", async () => {
    const file = new File(["hi"], "a.txt", { type: "text/plain" });
    await expect(fileToBase64(file)).resolves.toBe(btoa("hi"));
    await expect(fileToBase64(null)).rejects.toThrow("not a file");
  });

  it("builds data URLs for image previews", () => {
    expect(base64ToDataUrl(btoa("x"), "image/png")).toBe(`data:image/png;base64,${btoa("x")}`);
  });
});

describe("mime classification for previews", () => {
  it("detects images", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("text/plain")).toBe(false);
  });

  it("treats text/* and structured text mimes as previewable text", () => {
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("application/yaml")).toBe(true);
    expect(isTextMime("application/zip")).toBe(false);
    expect(isTextMime("")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("uses B / KiB / MiB", () => {
    expect(formatBytes(5)).toBe("5 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("composeMessageWithAttachments (J6 path reference lines)", () => {
  it("appends one 附件 line per uploaded path", () => {
    expect(composeMessageWithAttachments("请看截图", ["uploads/web/a.png", "uploads/web/b.pdf"]))
      .toBe("请看截图\n附件：uploads/web/a.png\n附件：uploads/web/b.pdf");
  });

  it("returns the bare text when there are no paths", () => {
    expect(composeMessageWithAttachments("hello", [])).toBe("hello");
    expect(composeMessageWithAttachments("hello", ["", " "])).toBe("hello");
  });

  it("can compose an attachment-only message", () => {
    expect(composeMessageWithAttachments("", ["uploads/web/a.png"])).toBe("附件：uploads/web/a.png");
  });

  it("trims trailing whitespace so the reference lines sit tight", () => {
    expect(composeMessageWithAttachments("text\n\n", ["p"])).toBe("text\n附件：p");
  });
});
