import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.jsx";
import { buildCommands } from "../lib/commands.js";

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

describe("Composer — queue mode toggle (audit #1)", () => {
  it("the follow_up/steer switch renders only while a turn is active and defaults to 排队追问", () => {
    const onQueueModeChange = vi.fn();
    const { rerender } = render(<Composer value="" onChange={() => {}} onSubmit={vi.fn()} active={false} onQueueModeChange={onQueueModeChange} />);
    expect(screen.queryByRole("group", { name: "队列模式" })).toBeNull();

    rerender(<Composer value="" onChange={() => {}} onSubmit={vi.fn()} active onQueueModeChange={onQueueModeChange} queueMode="follow_up" />);
    const group = screen.getByRole("group", { name: "队列模式" });
    expect(group.querySelector("button.selected").textContent).toContain("排队追问");
    expect(screen.getByRole("textbox").placeholder).toContain("排队追问");

    fireEvent.click(screen.getByTitle("立即插入当前回合（steer）"));
    expect(onQueueModeChange).toHaveBeenCalledWith("steering");
  });

  it("steer mode flips the selection and the placeholder", () => {
    renderComposer({ active: true, queueMode: "steering", onQueueModeChange: vi.fn() });
    const group = screen.getByRole("group", { name: "队列模式" });
    expect(group.querySelector("button.selected").textContent).toContain("转向 steer");
    expect(screen.getByRole("textbox").placeholder).toContain("steer");
  });
});

describe("Composer — interrupt arming hint (audit #1)", () => {
  it("shows 再按一次 Esc 停止 only while armed and mirrors it on the stop button", () => {
    const { rerender } = render(<Composer value="" onChange={() => {}} onSubmit={vi.fn()} active onCancel={() => {}} interruptArmed />);
    expect(screen.getByText("再按一次 Esc 停止")).not.toBeNull();
    expect(screen.getByTitle("再按一次 Esc 停止")).not.toBeNull();

    rerender(<Composer value="" onChange={() => {}} onSubmit={vi.fn()} active onCancel={() => {}} interruptArmed={false} />);
    expect(screen.queryByText("再按一次 Esc 停止")).toBeNull();
    expect(screen.getByTitle("Stop active turn")).not.toBeNull();
  });
});

describe("Composer — slash suggestions source the command registry (audit #9)", () => {
  it("typing / lists registry slash commands; clicking fills the slash form", () => {
    const commands = buildCommands({});
    const onChange = vi.fn();
    renderComposer({ value: "/the", onChange, commands });
    const options = document.querySelectorAll(".slash-suggestions button");
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain("/theme");
    fireEvent.click(options[0]);
    expect(onChange).toHaveBeenCalledWith("/theme ");
  });
});

describe("Composer — oversized files are never silently dropped", () => {
  it("files above 8MB show a notice and add no chip", () => {
    renderComposer();
    const big = new File(["x".repeat(100)], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 9 * 1024 * 1024 });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [big] } });
    expect(screen.getByText("1 个文件超过 8MB，未添加")).not.toBeNull();
    expect(document.querySelector(".upload-chip")).toBeNull();
  });
});

describe("Composer — draft history (↑ recall)", () => {
  function HistoryHarness(props = {}) {
    const [value, setValue] = useState("");
    const sent = [];
    return <Composer
      {...props}
      value={value}
      onChange={setValue}
      onSubmit={(text) => { sent.push(text); setValue(""); }}
    />;
  }

  function send(text) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  }

  it("ArrowUp recalls sent prompts newest-first; ArrowDown returns and restores the live draft", () => {
    render(<HistoryHarness />);
    const textarea = screen.getByRole("textbox");
    send("first message");
    send("second message");

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("second message");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("first message");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("first message"); // oldest stops

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("second message");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe(""); // past newest → live draft
  });

  it("recall only starts from an empty input; a draft is left untouched", () => {
    render(<HistoryHarness />);
    const textarea = screen.getByRole("textbox");
    send("sent one");

    fireEvent.change(textarea, { target: { value: "draft in progress" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("draft in progress"); // caret-safe: no hijack
  });
});
