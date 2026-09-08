import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Inspector } from "./Inspector.jsx";

afterEach(cleanup);


describe("Inspector — context meter tiers (crush-style color stepping)", () => {
  it.each([
    [0.4, ""],
    [0.8, "high"],
    [0.95, "near-full"],
  ])("usage %s gets the %s tier badge and hint", (usage, tone) => {
    cleanup();
    const { container } = render(<Inspector info={{}} stats={{ context_usage_percent: usage, input_tokens: 1000, context_window_tokens: 200000 }} goal={null} plan={[]} models={[]} effort="" connection="connected" onModel={() => {}} onEffort={() => {}} onRefreshModels={() => {}} onCompact={() => {}} compacting={false} currentModel="" />);
    expect(container.querySelector(".context-badge span").className).toContain(tone || "");
    if (tone) expect(container.querySelector(".context-badge em")).not.toBeNull();
    else expect(container.querySelector(".context-badge em")).toBeNull();
  });
});
