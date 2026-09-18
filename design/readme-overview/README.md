# README overview artwork

The two SVGs follow [rindai.dev](https://rindai.dev): warm paper, ink, moss green,
restrained lime, editorial headings, fine rules, and the site's ring sculpture.
They share the same 1440 × 1120 layout and localized copy.

The entry-point strip leads into the CLI surface/worker boundary. The dark engine
band explains requests/events, on-demand execution, and disk-backed history.
Three open columns introduce the built-in guide, persistent specialist files,
and run/send automation. A note distinguishes local worker processes from
WebSocket clients. Commands are labels, not simulated terminal screenshots.

Regenerate both language editions from the repository root:

```bash
python design/readme-overview/generate.py
```

Outputs: `assets/rind-architecture.svg` and `assets/rind-architecture.zh-CN.svg`.
The standard-library generator needs no external packages or website checkout.
The files contain no external fonts, images, JavaScript, or `foreignObject`.
Font stacks prefer the website's families with system sans/serif/monospace and
CJK fallbacks; exact glyph shapes depend on the viewer's installed fonts.
Text stays editable, and SVG keeps lines and labels sharp on GitHub at any scale.

Visual review covers both languages at native size and README widths, including
the title hierarchy, website palette, ring geometry, process arrows, text fit,
and spacing between columns. Small screens scale the whole illustration; open
the SVG directly to inspect details. The README repeats the concepts as text.
