import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { Container } from "../lib/tui/component.js";
import { ToolBlock } from "../lib/components/tool-block.js";
import { AssistantMessage } from "../lib/components/assistant-message.js";

// L1 diagnostic only: no terminal, Runtime, provider, or public scoring.
const fixture = {
  width: 100,
  assistant: "A completed response with ordinary text and some content.\n".repeat(8),
  result: JSON.stringify({ data: {
    stdout: "A completed output line for benchmark.\n".repeat(60),
    stderr: "", exit_code: 0,
  } }),
};
const samples = [];
for (const kind of ["assistant", "tool"]) {
  for (const count of [20, 100, 400]) {
    const root = new Container();
    for (let index = 0; index < count; index++) {
      if (kind === "assistant") {
        const block = new AssistantMessage({ color: false });
        block.append(fixture.assistant);
        block.finish();
        root.addChild(block);
      } else {
        const block = new ToolBlock({
          event: { tool_name: "bash", arguments: { command: "echo example" } },
          animate: false,
        });
        block.finish({ status: "completed", duration_ms: 42, result: fixture.result });
        root.addChild(block);
      }
    }
    for (let frame = 0; frame < 5; frame++) root.render(fixture.width);
    for (let trial = 0; trial < 5; trial++) {
      const before = process.cpuUsage();
      const start = performance.now();
      let lines;
      for (let frame = 0; frame < 30; frame++) lines = root.render(fixture.width);
      const wallMs = (performance.now() - start) / 30;
      const cpu = process.cpuUsage(before);
      samples.push({ kind, count, trial, lines: lines.length, wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000 / 30,
        heapUsed: process.memoryUsage().heapUsed,
        outputHash: createHash("sha256").update(lines.join("\n")).digest("hex"),
      });
    }
  }
}
console.log(JSON.stringify({
  level: "L1", publicScoreEligible: false,
  manifest: {
    sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0].model,
    logicalProcessors: cpus().length,
    fixtureHash: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"),
  }, samples,
}, null, 2));
