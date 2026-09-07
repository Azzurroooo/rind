import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree.jsx";

afterEach(cleanup);

function b64(text) {
  return btoa(text);
}

const rootEntries = [
  { name: "src", type: "dir", size: 0 },
  { name: "README.md", type: "file", size: 120 },
  { name: "logo.png", type: "file", size: 4096 },
];

describe("FileTree — panel and directory browsing (file/list)", () => {
  it("stays collapsed until opened; first open loads the workspace root", async () => {
    const listFiles = vi.fn(async () => ({ entries: rootEntries }));
    render(<FileTree workspace="E:/w" listFiles={listFiles} readFile={vi.fn()} />);
    expect(listFiles).not.toHaveBeenCalled();
    expect(document.querySelector(".file-tree-body")).toBeNull();

    fireEvent.click(screen.getByText("工作区文件"));
    expect(listFiles).toHaveBeenCalledWith("");
    await waitFor(() => expect(screen.getByText("README.md")).not.toBeNull());
    expect(screen.getByText("src")).not.toBeNull();
    // dirs sort before files
    const rows = [...document.querySelectorAll(".tree-row")].map((row) => row.textContent);
    expect(rows[0]).toContain("src");
  });

  it("folders expand lazily one level at a time", async () => {
    const listFiles = vi.fn(async (path) => (
      path === "" ? { entries: rootEntries } : { entries: [{ name: "app.py", type: "file", size: 10 }] }
    ));
    render(<FileTree workspace="E:/w" listFiles={listFiles} readFile={vi.fn()} />);
    fireEvent.click(screen.getByText("工作区文件"));
    await waitFor(() => expect(screen.getByText("src")).not.toBeNull());
    expect(listFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("app.py")).not.toBeNull());
    expect(listFiles).toHaveBeenCalledWith("src");
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("shows loading, empty and error states with retry", async () => {
    let failing = true;
    const listFiles = vi.fn(async () => {
      if (failing) throw new Error("workspace gone");
      return { entries: [] };
    });
    render(<FileTree workspace="E:/w" listFiles={listFiles} readFile={vi.fn()} />);
    fireEvent.click(screen.getByText("工作区文件"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("workspace gone"));

    failing = false; // the click invokes listFiles synchronously
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(screen.getByText("空目录")).not.toBeNull());
  });

  it("without a workspace it shows the idle hint and never calls the protocol", () => {
    const listFiles = vi.fn();
    render(<FileTree workspace="" listFiles={listFiles} readFile={vi.fn()} />);
    fireEvent.click(screen.getByText("工作区文件"));
    expect(screen.getByText("未选择工作区")).not.toBeNull();
    expect(listFiles).not.toHaveBeenCalled();
  });
});

describe("FileTree — file preview (file/read)", () => {
  it("decodes text files from base64", async () => {
    const readFile = vi.fn(async () => ({ content_base64: b64("# hello"), mime: "text/markdown", size: 7 }));
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: rootEntries }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("README.md"));
    await waitFor(() => expect(screen.getByText(/# hello/)).not.toBeNull());
    expect(readFile).toHaveBeenCalledWith("README.md");
  });

  it("shows images via a data URL", async () => {
    const readFile = vi.fn(async () => ({ content_base64: b64("pngdata"), mime: "image/png", size: 8 }));
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: rootEntries }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("logo.png"));
    await waitFor(() => expect(document.querySelector(".tree-preview-image")).not.toBeNull());
    expect(document.querySelector(".tree-preview-image").src).toContain("data:image/png;base64,");
  });

  it("binary files get a size + hint instead of garbage", async () => {
    const readFile = vi.fn(async () => ({ content_base64: b64("PK"), mime: "application/zip", size: 9000 }));
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: [{ name: "bundle.zip", type: "file", size: 9000 }] }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("bundle.zip"));
    await waitFor(() => expect(screen.getByText(/二进制文件/)).not.toBeNull());
    expect(document.querySelector(".tree-preview").textContent).toContain("8.8 KiB");
  });

  it("files above the 8 MiB limit are rejected before reading", async () => {
    const readFile = vi.fn();
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: [{ name: "huge.bin", type: "file", size: 9 * 1024 * 1024 }] }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("huge.bin"));
    await waitFor(() => expect(screen.getByText(/文件过大/)).not.toBeNull());
    expect(readFile).not.toHaveBeenCalled();
  });

  it("read errors surface inline", async () => {
    const readFile = vi.fn(async () => { throw new Error("NotFound"); });
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: rootEntries }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("README.md"));
    await waitFor(() => expect(screen.getAllByRole("alert")[0].textContent).toContain("NotFound"));
  });

  it("preview can be closed", async () => {
    const readFile = vi.fn(async () => ({ content_base64: b64("hey"), mime: "text/plain", size: 3 }));
    render(<FileTree workspace="E:/w" listFiles={vi.fn(async () => ({ entries: rootEntries }))} readFile={readFile} />);
    fireEvent.click(screen.getByText("工作区文件"));
    fireEvent.click(await screen.findByText("README.md"));
    await waitFor(() => expect(screen.getByText(/hey/)).not.toBeNull());
    fireEvent.click(screen.getByLabelText("关闭预览"));
    expect(document.querySelector(".tree-preview")).toBeNull();
  });
});
