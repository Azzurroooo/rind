import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.jsx";

afterEach(cleanup);

function makeFile(name = "shot.png", type = "image/png", body = "png") {
  return new File([body], name, { type });
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:mock" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
});

function renderComposer(overrides = {}) {
  const props = {
    value: "",
    onChange: () => {},
    onSubmit: vi.fn(),
    active: false,
    onCancel: () => {},
    onUpload: vi.fn(async (file) => `uploads/web/mock-${file.name}`),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe("Composer — attachments enter as chips (J6)", () => {
  it("pasted files become a chip row above the input", async () => {
    renderComposer();
    const textarea = screen.getByRole("textbox");
    fireEvent.paste(textarea, { clipboardData: { files: [makeFile()] } });
    await waitFor(() => expect(document.querySelector(".upload-chip")).not.toBeNull());
    expect(screen.getByText("shot.png")).not.toBeNull();
  });

  it("dropped files upload through file/write and the chip resolves to ok with the path", async () => {
    const onUpload = vi.fn(async () => "uploads/web/20260101-000000-shot.png");
    renderComposer({ onUpload });
    const shell = document.querySelector(".composer-shell");
    fireEvent.drop(shell, { dataTransfer: { files: [makeFile()] } });
    expect(document.querySelector(".upload-chip.uploading")).not.toBeNull();
    await waitFor(() => expect(document.querySelector(".upload-chip.ok")).not.toBeNull());
    expect(onUpload).toHaveBeenCalledWith(expect.any(File));
    expect(screen.getByText(/uploads\/web\/20260101-000000-shot.png/)).not.toBeNull();
  });

  it("a rejected upload turns the chip failed and retry recovers it", async () => {
    let fail = true;
    const onUpload = vi.fn(async () => {
      if (fail) throw new Error("runtime offline");
      return "uploads/web/ok.png";
    });
    renderComposer({ onUpload });
    fireEvent.drop(document.querySelector(".composer-shell"), { dataTransfer: { files: [makeFile()] } });
    await waitFor(() => expect(document.querySelector(".upload-chip.failed")).not.toBeNull());
    expect(screen.getByText(/runtime offline/)).not.toBeNull();
    // text input is never blocked by a failed upload
    expect(screen.getByRole("textbox").disabled).toBe(false);

    fail = false; // the click invokes onUpload synchronously — flip first
    fireEvent.click(screen.getByTitle("重试上传"));
    await waitFor(() => expect(document.querySelector(".upload-chip.ok")).not.toBeNull());
    expect(onUpload).toHaveBeenCalledTimes(2);
  });

  it("the delete button removes a chip in any state", async () => {
    const onUpload = vi.fn(() => new Promise(() => {})); // never settles
    renderComposer({ onUpload });
    fireEvent.drop(document.querySelector(".composer-shell"), { dataTransfer: { files: [makeFile()] } });
    await waitFor(() => expect(document.querySelector(".upload-chip")).not.toBeNull());
    fireEvent.click(screen.getByTitle("移除附件"));
    expect(document.querySelector(".upload-chip")).toBeNull();
  });
});

describe("Composer — sending with attachments (J6)", () => {
  it("appends one path reference line per uploaded chip", async () => {
    const onSubmit = vi.fn();
    renderComposer({ value: "请看截图", onChange: () => {}, onSubmit });
    fireEvent.drop(document.querySelector(".composer-shell"), { dataTransfer: { files: [makeFile()] } });
    await waitFor(() => expect(document.querySelector(".upload-chip.ok")).not.toBeNull());

    fireEvent.click(screen.getByTitle("Send message"));
    expect(onSubmit).toHaveBeenCalledWith("请看截图\n附件：uploads/web/mock-shot.png");
    // delivered chip leaves the row
    expect(document.querySelector(".upload-chip")).toBeNull();
  });

  it("a chip still uploading is NOT sent; a thin notice says so and the input stays enabled", async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const onUpload = vi.fn(() => new Promise(() => {})); // stuck uploading
    renderComposer({ value: "先发文本", onChange, onSubmit, onUpload });
    fireEvent.drop(document.querySelector(".composer-shell"), { dataTransfer: { files: [makeFile()] } });
    await waitFor(() => expect(document.querySelector(".upload-chip.uploading")).not.toBeNull());

    const send = screen.getByTitle("Send message");
    expect(send.disabled).toBe(false); // sending is never blocked
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe("先发文本"); // no attachment line
    expect(screen.getByRole("status").textContent).toBe("1 个附件仍在上传，未随消息发送");
    expect(screen.getByRole("textbox").disabled).toBe(false);
    // the uploading chip stays in the row for the next message
    expect(document.querySelector(".upload-chip.uploading")).not.toBeNull();
  });

  it("Enter sends the composed text (Enter submit contract preserved)", async () => {
    const onSubmit = vi.fn();
    renderComposer({ value: "hello", onChange: () => {}, onSubmit });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });
});
