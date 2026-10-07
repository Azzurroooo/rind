import { COLORS, MARK } from "../brand.mjs";

export const HEX = COLORS;
export const PALETTE = Object.fromEntries(["shell", "core"].map((key) => [
  key, `2;${COLORS[key].slice(1).match(/../g).map((value) => parseInt(value, 16)).join(";")}`,
]));

function insideRoundedRect(x, y, inset, radius) {
  const end = MARK.size - inset;
  if (x < inset || x > end || y < inset || y > end) return false;
  const cx = Math.max(inset + radius, Math.min(end - radius, x));
  const cy = Math.max(inset + radius, Math.min(end - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function classify(x, y) {
  if (!insideRoundedRect(x, y, 0, MARK.radius)) return null;
  return x + y >= MARK.cut && insideRoundedRect(x, y, MARK.inset, MARK.coreRadius) ? "core" : "shell";
}

export function rasterize(size = 24) {
  const grid = Array.from({ length: size * size }, (_, index) => classify(
    (index % size + 0.5) / size * MARK.size,
    (Math.floor(index / size) + 0.5) / size * MARK.size,
  ));
  return { width: size, height: size, grid };
}

export function halfBlock(upper, lower) {
  if (upper && lower) return { char: "▀", foreground: upper, background: lower };
  if (upper) return { char: "▀", foreground: upper, background: null };
  if (lower) return { char: "▄", foreground: lower, background: null };
  return { char: " ", foreground: null, background: null };
}

export function renderMark(size = 24) {
  const { grid } = rasterize(size);
  const rows = [];
  for (let y = 0; y < size; y += 2) {
    let row = "";
    for (let x = 0; x < size; x += 1) {
      const cell = halfBlock(grid[y * size + x], grid[(y + 1) * size + x]);
      row += "\x1b[0m";
      if (cell.foreground) row += `\x1b[38;${PALETTE[cell.foreground]}m`;
      if (cell.background) row += `\x1b[48;${PALETTE[cell.background]}m`;
      row += cell.char;
    }
    rows.push(row + "\x1b[0m");
  }
  return rows.join("\n");
}

export function renderMarkText(size = 24) {
  const glyph = { shell: "·", core: "█" };
  const { grid } = rasterize(size);
  return Array.from({ length: size }, (_, y) => grid.slice(y * size, (y + 1) * size)
    .map((key) => glyph[key] || " ").join("")).join("\n");
}
