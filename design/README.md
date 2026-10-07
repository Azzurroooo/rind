# Shared Rind logo

The mark matches the website favicon: a 32 × 32 deep-green rounded tile (`#243d2e`, radius 8), a pale-green core (`#d6df9a`, inset 4, radius 4), and the diagonal from `(22, 4)` to `(4, 22)`. No stroke, filter, or glow.

- [Static SVG](../assets/rind.svg)
- [Animated SVG](../assets/rind-animated.svg)
- [Interactive preview](rind-logo.html): pause, replay, and 0.1× playback; works directly from a local file.
- [PNG exports](icons/README.md): 16, 32, 48, 192, 512 px.
- [Terminal rendition](cli-logo/README.md)

`brand.mjs` is the drawing source. It supplies the geometry, colors, SVGs, and terminal palette. `generate-brand.mjs` writes the identical static SVG to the README, Web/Mobile public assets, and Desktop renderer, plus the Desktop app icon, social artwork, PNG exports, and preview. Generated resources are committed so app builds do not need raster tools.

Regenerate from the repository root:

```sh
npm --prefix mobile ci
node design/generate-brand.mjs
npm --prefix mobile run icons
```

The raster generator reuses Mobile's existing `sharp` development dependency. `mobile/scripts/icons.mjs` uses the same drawing source and updates all Android densities, adaptive foregrounds, iOS icons, and native splash screens. Native canvases retain their existing platform padding and background.

The animated SVG moves the core 1 unit outward along the diagonal and returns it to the exact static shape. A 3.6-second cycle contains a long resting phase; `prefers-reduced-motion: reduce` disables it. It needs no JavaScript, external fonts, or library. Use the static mark for app icons, favicons, and routine interface branding; reserve motion for an intentional brand presentation. The animated version is provided as an asset, without adding continuous animation to app screens.
