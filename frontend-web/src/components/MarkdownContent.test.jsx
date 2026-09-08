import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent.jsx";

afterEach(cleanup);

describe("MarkdownContent — fenced code cards", () => {
  it("renders the language label and copies the code on click", async () => {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    render(<MarkdownContent value={"```python\nprint('hi')\n```"} />);
    expect(screen.getByText("python")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith("print('hi')"));
    await waitFor(() => expect(screen.getByRole("button", { name: "已复制" })).not.toBeNull());
  });

  it("unlabeled fences fall back to the generic label", () => {
    render(<MarkdownContent value={"```\nplain\n```"} />);
    expect(screen.getByText("code")).not.toBeNull();
  });
});
