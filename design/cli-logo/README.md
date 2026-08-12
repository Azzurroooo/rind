# rind-cli-logo

The Rind mark rendered into a terminal with Unicode half-block cells and
ANSI 256-colour. The same cold-shell / warm-core / cyan-cut idea as the SVG
logo, but rasterised onto a grid so it can print at startup, in `--help`, or
anywhere a CLI wants a wordless brand mark.

## Run

```sh
node demo.js
```

You should see the mark on the left (cyan tile outline, dark shell, amber
core, bright cyan cut) with the startup line beside it.

## How it works

`logo.js` expresses the mark as geometry in normalised space — a rounded tile,
a diagonal cut segment, and the half-plane each side of it. `classify(x, y)`
returns one of `border / shell / core / cut` per pixel. `renderMark(size)`
samples a `size × size` grid and folds every two pixel rows into one
character row:

- both rows lit → `▀` with the upper colour as foreground, lower as background
- upper only   → `▀`
- lower only   → `▄`
- neither      → space

So a 24-pixel mark prints as 24 columns by 12 rows. Colours come from
`PALETTE`, tweakable independently of shape.

`renderMarkText(size)` prints the same shape with letters (`B · o /`) for
checking the rasterisation in a non-colour terminal.
