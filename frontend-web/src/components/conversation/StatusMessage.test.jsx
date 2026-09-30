import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StatusMessage } from "./StatusMessage.jsx";

afterEach(cleanup);
it("renders the actual CLI status protocol including cache usage and context capacity", () => {
  const { container } = render(<StatusMessage display={{
    entries: [{ label: "model", value: "test-model" }, { label: "reasoningEffort", value: "high" }, { label: "settings", value: "/home/settings.json", state: "found" }],
    usage: [{ input_tokens: 12000, context_window_tokens: 100000, context_usage_percent: 0.12, cached_input_tokens: 9000, cache_hit_rate: 0.75, output_tokens: 345 }],
  }} />);
  for (const text of ["test-model", "Reasoning effort", "high", "found", "12.0%", "Cached input", "· 75.0% hit", "345"]) expect(screen.getByText(text)).toBeTruthy();
  expect(container.querySelector("meter").value).toBe(0.12);
  expect(container.textContent).toContain((9000).toLocaleString());
  expect(container.textContent).toContain((100000).toLocaleString());
});
it("distinguishes absent sampling from a completed sample with zero cache hits", () => {
  const { rerender } = render(<StatusMessage display={{ entries: [], usage: [] }} />);
  expect(screen.getByText("No completed sampling yet.")).toBeTruthy();
  rerender(<StatusMessage display={{ entries: [], usage: [{ input_tokens: 12, cached_input_tokens: 0, cache_hit_rate: 0, output_tokens: 1 }] }} />);
  expect(screen.getByText("· 0.0% hit")).toBeTruthy();
  expect(screen.queryByText("No completed sampling yet.")).toBeNull();
  expect(document.querySelector("meter")).toBeNull();
});
