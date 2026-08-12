// Rasterises the Rind mark into a grid of cells and prints it with Unicode
// half-blocks (▀ upper / ▄ lower) so one character row encodes two pixel
// rows. Colour is ANSI 256, mirroring the terminal UI palette:
//   shell  = cold dark wall
//   core   = warm amber interior
//   cut    = bright cyan slash (also the project accent)
//   border = cyan tile outline

export const PALETTE = {
  border: "5;81",
  shell: "5;238",
  core: "5;179",
  cut: "5;51",
};

// CSS equivalents of the ANSI codes above, for the HTML preview.
export const HEX = {
  border: "#5fd7ff",
  shell: "#444444",
  core: "#d7af5f",
  cut: "#00ffff",
};

// Geometry in normalised [0,1] space, tuned to look right at ~24 cells.
const TILE = { margin: 0.1, radius: 0.18, border: 0.07 };
const CUT = { ax: 0.66, ay: 0.1, bx: 0.1, by: 0.66, halfWidth: 0.05 };

function insideRoundedRect(x, y, inset) {
  const left = TILE.margin + inset;
  const right = 1 - TILE.margin - inset;
  const top = TILE.margin + inset;
  const bottom = 1 - TILE.margin - inset;
  if (x < left || x > right || y < top || y > bottom) return false;
  const r = Math.max(0, TILE.radius - inset);
  const nearLeft = x < left + r;
  const nearRight = x > right - r;
  const nearTop = y < top + r;
  const nearBottom = y > bottom - r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? left + r : right - r;
    const cy = nearTop ? top + r : bottom - r;
    if (Math.hypot(x - cx, y - cy) > r) return false;
  }
  return true;
}

function distanceToCut(x, y) {
  const dx = CUT.bx - CUT.ax;
  const dy = CUT.by - CUT.ay;
  const len2 = dx * dx + dy * dy;
  let t = ((x - CUT.ax) * dx + (y - CUT.ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (CUT.ax + t * dx), y - (CUT.ay + t * dy));
}

function cutSide(x, y) {
  return (CUT.bx - CUT.ax) * (y - CUT.ay) - (CUT.by - CUT.ay) * (x - CUT.ax);
}

function classify(x, y) {
  if (!insideRoundedRect(x, y, 0)) return null;
  if (distanceToCut(x, y) < CUT.halfWidth) return "cut";
  if (!insideRoundedRect(x, y, TILE.border)) return "border";
  return cutSide(x, y) > 0 ? "shell" : "core";
}

export function rasterize(size = 24) {
  const width = size;
  const height = size;
  const grid = new Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      grid[row * width + col] = classify((col + 0.5) / width, (row + 0.5) / height);
    }
  }
  return { width, height, grid };
}

function paint(key, background) {
  if (!key) return "";
  return `\x1b[${background ? "48" : "38"};${PALETTE[key]}m`;
}

function emitCell(upper, lower) {
  if (upper && lower) return { ch: "▀", fg: upper, bg: lower };
  if (upper) return { ch: "▀", fg: upper, bg: null };
  if (lower) return { ch: "▄", fg: lower, bg: null };
  return { ch: " ", fg: null, bg: null };
}

export function renderMark(size = 24) {
  const { width, height, grid } = rasterize(size);
  let out = "";
  for (let row = 0; row < height; row += 2) {
    for (let col = 0; col < width; col += 1) {
      const upper = grid[row * width + col];
      const lower = row + 1 < height ? grid[(row + 1) * width + col] : null;
      const cell = emitCell(upper, lower);
      out += paint(cell.fg, false) + paint(cell.bg, true) + cell.ch;
    }
    out += "\x1b[0m";
    if (row + 2 < height) out += "\n";
  }
  return out;
}

// Plain-text preview that swaps colour for letters — handy for checking the
// rasterised shape without a colour terminal.
export function renderMarkText(size = 24) {
  const glyph = { border: "B", shell: "·", core: "o", cut: "/" };
  const { width, height, grid } = rasterize(size);
  let out = "";
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const key = grid[row * width + col];
      out += key ? glyph[key] : " ";
    }
    if (row + 1 < height) out += "\n";
  }
  return out;
}
