# Rind terminal mark

The same deep-green shell and pale-green core as [the shared SVG](../../assets/rind.svg), sampled into Unicode half-block cells with ANSI true color. No border, slash overlay, glow, or extra palette.

```sh
node design/cli-logo/demo.js
```

`logo.js` imports the palette and 32-unit geometry from `design/brand.mjs`. `rasterize(size)` samples that geometry; `halfBlock(upper, lower)` is shared by the terminal and browser previews. `renderMark(size)` produces `size` columns and `ceil(size / 2)` rows, with ANSI resets preventing color bleed into adjacent text. `renderMarkText(size)` gives a plain-text shape without escape sequences.

Serve the repository with `python -m http.server 8765 --bind 127.0.0.1` and open `/design/cli-logo/preview.html` to view the browser rendition. It imports the same drawing code instead of maintaining a second rasterizer. The CLI startup banner remains a text wordmark.
