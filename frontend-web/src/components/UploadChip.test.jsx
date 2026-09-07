import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadChip } from "./UploadChip.jsx";

afterEach(cleanup);

const base = { id: "chip-1", name: "screenshot.png", size: 2048, mime: "image/png", previewUrl: "blob:x", path: "", error: "" };

describe("UploadChip — four states of §2.4", () => {
  it("uploading: spinner veil, size label, delete available, no retry", () => {
    const onDelete = vi.fn();
    render(<UploadChip chip={{ ...base, status: "uploading" }} onDelete={onDelete} />);
    expect(document.querySelector(".upload-chip.uploading")).not.toBeNull();
    expect(screen.getByText(/2.0 KiB/)).not.toBeNull();
    expect(screen.getByText(/上传中/)).not.toBeNull();
    expect(screen.queryByTitle("重试上传")).toBeNull();
    fireEvent.click(screen.getByTitle("移除附件"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("ok: shows the stored path and no retry", () => {
    render(<UploadChip chip={{ ...base, status: "ok", path: "uploads/web/x.png" }} onDelete={() => {}} />);
    expect(document.querySelector(".upload-chip.ok")).not.toBeNull();
    expect(screen.getByText(/uploads\/web\/x.png/)).not.toBeNull();
    expect(screen.queryByTitle("重试上传")).toBeNull();
  });

  it("failed: red styling, error text and a working retry button", () => {
    const onRetry = vi.fn();
    const { container } = render(<UploadChip chip={{ ...base, status: "failed", error: "runtime offline" }} onRetry={onRetry} onDelete={() => {}} />);
    expect(document.querySelector(".upload-chip.failed")).not.toBeNull();
    expect(screen.getByText(/runtime offline/)).not.toBeNull();
    fireEvent.click(screen.getByTitle("重试上传"));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "chip-1", status: "failed" }));
    expect(container.querySelector(".chip-retry")).not.toBeNull();
  });

  it("delete stays available in every state", () => {
    const onDelete = vi.fn();
    const { rerender } = render(<UploadChip chip={{ ...base, status: "uploading" }} onDelete={onDelete} />);
    fireEvent.click(screen.getByTitle("移除附件"));
    rerender(<UploadChip chip={{ ...base, status: "failed" }} onDelete={onDelete} />);
    fireEvent.click(screen.getByTitle("移除附件"));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("non-image files get an icon instead of a thumbnail", () => {
    render(<UploadChip chip={{ ...base, name: "data.zip", mime: "application/zip", previewUrl: "", status: "ok", path: "uploads/web/data.zip" }} onDelete={() => {}} />);
    expect(document.querySelector(".chip-thumb img")).toBeNull();
    expect(document.querySelector(".chip-thumb svg")).not.toBeNull();
  });

  it("images show their thumbnail", () => {
    render(<UploadChip chip={{ ...base, status: "ok", path: "uploads/web/s.png" }} onDelete={() => {}} />);
    expect(document.querySelector(".chip-thumb img")).not.toBeNull();
  });
});
