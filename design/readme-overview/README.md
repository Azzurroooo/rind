# README overview artwork

The two SVGs share geometry, typography, and the Rind logo's charcoal, cyan,
and gold palette. They explain the CLI process boundary, execution lifecycle,
persistent specialist workspaces, and script entry points. The footer distinguishes
local worker processes from WebSocket clients.

Regenerate both language editions from the repository root:

```bash
python design/readme-overview/generate.py
```

Outputs: `assets/rind-architecture.svg` and `assets/rind-architecture.zh-CN.svg`.
The files contain no external fonts, images, JavaScript, or `foreignObject`.
Text stays editable, and SVG keeps lines and labels sharp on GitHub at any scale.
