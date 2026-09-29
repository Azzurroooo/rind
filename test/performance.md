# Low-load verification

These development tools add no production dependency and never run a real model.

- `node frontend-cli/test/bench-render.mjs`: L1 completed assistant/tool rendering, five trials at each history size, fixture/output hashes, wall/CPU time and heap samples. Redirect JSON to a result file. Use a separate invocation with Node's `--cpu-prof` to diagnose; do not score profiled runs.
- `node frontend-cli/test/bench-tui.mjs`: L1 real TUI layout/diff with 400/4,000 completed tools and a changing status line. Counts writes and bytes, but does not draw in a real terminal and cannot receive a public score.
- `python test/bench_cancellation.py`: L1 10,000-chunk cancellation timing, five unprofiled CPU samples followed by a separate cProfile run.
- `python test/bench_interactive.py --manifest launch.json`: isolated local SSE provider plus the normal Rind interactive CLI. Run only in an authorized visible terminal. Type a prompt, observe streaming, then `/exit`. Workspace and RIND_HOME are temporary. Provider diagnostics go to a temporary log, leaving the TUI as the only terminal writer. Observed child processes are cleaned up on exit/interruption. This is a replay smoke fixture, **not** the complete C01–C10 workload or a resource sampler.
- `python test/bench_processes.py --tree agent:PID --root provider:PID --root terminal:PID --seconds 60 --output samples.jsonl`: Windows diagnostic sampler with 250 ms intervals. Use the launch manifest's agent/provider/console host PIDs, verifying the actual renderer separately when using a terminal other than conhost. Roots include only the named process; trees retain observed descendants even after reparenting. The sampler records itself separately. `psutil` is a development dependency only.
- `python test/score_load.py report.json`: Windows candidate-budget arithmetic and qualification checks. It requires all ten L3 scenario summaries and never normalizes missing coverage. It validates reported qualification, not the authenticity of screenshots or samples; a reviewer must verify that evidence separately. Budgets are still provisional until P0's full instrumentation is calibrated, so this tool does not yet confer an official ranking.

The scenario matrix, resource attribution, timing, repetitions and experience gates are defined in `.docs/rind-low-load-optimization-plan-zh.md`. L3 requires the same visible terminal emulator, actual drawing, normal interactive input, full agent process-tree accounting and independent provider/tool/terminal measurements. Having a PTY alone is insufficient. Manual/live acceptance follows `test/README.md`; an implementation request does not automatically authorize it.

Scoring input is one object with `level: "L3"`, `correctness_passed: true`, `manifest`, and `scenarios`. `manifest` requires `os: "windows"`, true values for `interactive`, `tty`, `visible`, `foreground`, `ui_verified`, and nonempty `product_sha`, `command`, `terminal`, `fixture_sha256`, `ui_evidence`, `raw_samples`. Preserve raw trial samples, source/build hashes and confidence intervals alongside the summary; do not substitute fixture unit-test data for measurements.

`scenarios` contains exactly C01–C10. Each entry contains the trial-median metrics below, with trial count `trials` (at least 30 for C01, 5 otherwise). Tail and cancellation observations must meet their corresponding plan gates.

| Metric | Unit / scope |
|---|---|
| `cpu_ms` | C01, agent process-tree CPU milliseconds |
| `cpu_core_percent` | C02–C10, process-tree CPU / monotonic wall time × 100 |
| `private_bytes_p95`, `private_bytes_peak` | Windows agent tree Private Bytes, not working set |
| `output_bytes` | C01, terminal output bytes |
| `output_bytes_per_second` | C02–C10, terminal output rate |
| `first_input_ms` | C01, launch to first usable input frame |
| `input_p95_ms`, `input_p99_ms` | C02–C10, visible input latency |
| `stream_p95_ms`, `tail_ms` | C05–C09, visible streaming and completion-to-visible-tail latency |
| `cancel_p95_ms` | C04–C09, UI cancellation confirmation latency |

Synthetic scoring tests verify rejection and arithmetic only. Until all L3 evidence exists, report scenario coverage and raw values without ranking or energy claims.

The process sampler stores raw cumulative user+kernel CPU seconds, process creation time, monotonic observation times, Private Bytes, working set and read duration. Calculate CPU from differences, never from lifetime averages; do not sum agent and provider trees when the launcher owns the agent child. Root overlap is an error. Failed reads and observed exits remain explicit in the output. Polling misses processes that start and exit between ticks and cannot collect their final CPU counters, so these samples are diagnostic and always carry `public_score_eligible: false`. ETW/equivalent lifecycle accounting, full fixtures, output/latency instrumentation and visible-frame evidence are still required for official scoring. A successful `isatty()` check or process launch alone cannot certify L3.

Manifest and sample destinations must be new files, preserving earlier trial evidence. Retained reports are deliberate outputs; temporary homes, provider logs and sessions are removed by the replay launcher. This smoke fixture does not create background tool processes; arbitrary descendant escape/rapid spawning needs the plan's separate lifecycle instrumentation.
