import { performance } from "node:perf_hooks";
import { createTui } from "../lib/tui/tui.js";
import { createTranscript } from "../lib/tui/transcript.js";
import { ToolBlock } from "../lib/components/tool-block.js";

const samples = [];
for (const count of [400, 4000]) {
  const transcript = createTranscript();
  for (let i = 0; i < count; i++) {
    const block = new ToolBlock({ event: { tool_name: "bash", arguments: { command: "echo example" } }, animate: false });
    block.finish({ status: "completed", result: JSON.stringify({ data: { stdout: "completed output\n".repeat(60) } }) });
    transcript.addChild(block);
  }
  let frame = 0, bytes = 0, writes = 0;
  const scheduled = new Map();
  const tui = createTui({ input: {}, output: { columns: 100, rows: 30,
    write(value) { bytes += Buffer.byteLength(value); writes++; return true; } },
    manageInput: false, renderIntervalMs: 0,
    setTimeout(callback, delay) { const id = {}; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
  });
  tui.addChild(transcript);
  tui.addChild({ render: () => [`Working ${frame}`] });
  tui.start();
  async function flush() {
    await Promise.resolve();
    for (const [id, entry] of scheduled) {
      if (entry.delay === 0) { scheduled.delete(id); entry.callback(); }
    }
  }
  await flush();
  for (let trial = 0; trial < 5; trial++) {
    const start = performance.now(), cpu = process.cpuUsage();
    bytes = 0; writes = 0;
    for (let i = 0; i < 30; i++) { frame++; tui.requestRender(true); await flush(); }
    const used = process.cpuUsage(cpu);
    samples.push({ count, trial, wallMs: (performance.now() - start) / 30,
      cpuMs: (used.user + used.system) / 30000, bytes, writes });
  }
  tui.stop();
}
console.log(JSON.stringify({ level: "L1", publicScoreEligible: false, samples }, null, 2));
