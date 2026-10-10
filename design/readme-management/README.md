# README management screenshot

`assets/agents-management.png` captures the current CLI's actual `renderAgents`
output with a fictional eight-member coding team. The application's own model
projections produce the organization, tasks, statuses, detail pane and key hints.
No running task or model result is claimed by this illustration.

The ANSI frame is interpreted by the CLI's existing `@xterm/headless` dependency.
Chromium captures those terminal cells at 2x resolution. Box-drawing characters
join at cell boundaries, as in a terminal. No panel text or layout is handwritten.
`capture.json` records the source commit and the native frame for review.

Regenerate after installing `frontend-cli` dependencies and Playwright Chromium:

```sh
node design/readme-management/capture.mjs --browser-package=../rind-web/package.json
```

The browser package can be any local package with `@playwright/test` installed.
The script never starts Rind services, touches real teams or calls providers.
