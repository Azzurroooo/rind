# README overview artwork

The two SVGs follow Rind's visual identity: warm paper, ink, moss green,
restrained lime, editorial headings, fine rules, and the ring sculpture.
They share the same 1440 × 1110 layout and localized copy.

The headline carries the positioning: light by design, folders are agents. The dark
band pairs a folder tree with the team loop (brief, delegate, report, deliver). Three
open columns cover the lean worker, Agents Management and the reusable parts; the
footer lists secondary features. Commands are labels, not simulated terminal screenshots.

Regenerate both language editions from the repository root:

```bash
python design/readme-overview/generate.py
```

Outputs: `assets/rind-overview.svg` and `assets/rind-overview.zh-CN.svg`.
The standard-library generator needs no external packages.
The files contain no external fonts, images, JavaScript, or `foreignObject`.
Font stacks use system sans/serif/monospace and
CJK fallbacks; exact glyph shapes depend on the viewer's installed fonts.
Text stays editable, and SVG keeps lines and labels sharp on GitHub at any scale.

Visual review covers both languages at native size and README widths, including
the title hierarchy, brand palette, ring geometry, tree alignment, text fit,
and spacing between columns. Small screens scale the whole illustration; open
the SVG directly to inspect details. The README repeats the concepts as text.
