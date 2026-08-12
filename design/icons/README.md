# Rind icons

Two icon sets from one mark, plus an animated version of the colour icon.

## Sets

**Amber** — a single amber tile with the cut as a transparent gap (knocked
out with an SVG mask, not a line drawn on top). Stays legible at the smallest
sizes.

**Color** — the full mark: cold shell, warm core, cyan cut with a soft glow.
Used where there are enough pixels for the detail.

**Color animated** — the colour icon with the cut as motion: the slash sweeps
in, the core glows through, then it resets. Loops; respects
`prefers-reduced-motion`.

## Files

```
amber.svg                     amber master (transparent cut)
amber-16.png  amber-32.png  amber-48.png  amber-192.png  amber-512.png
color.svg                     color master (shell · core · cut · glow)
color-16.png  color-32.png  color-48.png  color-192.png  color-512.png
color-animated.svg            animated colour icon
index.html                    visual catalogue
raster.html                   rasteriser page (PNG source)
generate-pngs.mjs             regenerates every PNG
```

All PNGs have a transparent background.

## Regenerating PNGs

Edit the SVG sources in `raster.html` (or the master `.svg` files), then:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright --no-save
node generate-pngs.mjs "file://$(pwd)/raster.html"
rm -rf node_modules package-lock.json
```

Sizes are `16 32 48 192 512` for both variants — change them in
`generate-pngs.mjs`.
