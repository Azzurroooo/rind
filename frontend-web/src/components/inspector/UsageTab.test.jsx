import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageTab } from "./UsageTab.jsx";
import { cacheHitRate } from "../../lib/usage.js";

describe("reported cache usage", () => {
  it("uses input tokens as the denominator and distinguishes zero from unavailable", () => {
    expect(cacheHitRate(1200, 300)).toBe(.25);
    expect(cacheHitRate(1200, 0)).toBe(0);
    for (const pair of [[0, 0], [12, undefined], [12, -1], [12, 20], [Infinity, 1]]) expect(cacheHitRate(...pair)).toBeNull();
  });
  it("shows cache read and hit rate in global Usage", async () => {
    render(<UsageTab usageEnabled request={async () => ({ totals: { input: 1200, cached: 300, output: 800, total: 2000, samples: 2 } })} />);
    expect(await screen.findByText("25.0%")).toBeTruthy();
    expect(screen.getByText("Cache read").nextElementSibling.textContent).toBe("300");
  });
  it("does not present missing cache data as a zero hit rate", async () => {
    render(<UsageTab usageEnabled request={async () => ({ totals: { input: 1200, samples: 1 } })} />);
    expect(await screen.findByText("Not reported")).toBeTruthy();
    expect(screen.getByText("Cache hit rate").nextElementSibling.textContent).toBe("—");
  });
});
