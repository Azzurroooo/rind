// Test-only terminal QR decoder for verifying rendered half-block QR payloads.

const VERSION_SPECS_L = [
  null,
  { total: 26, groups: [[1, 19]] },
  { total: 44, groups: [[1, 34]] },
  { total: 70, groups: [[1, 55]] },
  { total: 100, groups: [[1, 80]] },
  { total: 134, groups: [[1, 108]] },
  { total: 172, groups: [[2, 68]] },
  { total: 196, groups: [[2, 78]] },
  { total: 242, groups: [[2, 97]] },
  { total: 292, groups: [[2, 116]] },
  { total: 346, groups: [[2, 68], [2, 69]] },
];

const ALIGNMENT_COORDS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const textDecoder = new TextDecoder("utf-8");

function buildFunctionMask(version) {
  const size = 17 + version * 4;
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (row, col) => {
    if (row >= 0 && row < size && col >= 0 && col < size) isFunction[row][col] = true;
  };
  const markFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) mark(top + r, left + c);
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const rCenter of ALIGNMENT_COORDS[version]) {
    for (const cCenter of ALIGNMENT_COORDS[version]) {
      if (
        (rCenter === 6 && cCenter === 6) ||
        (rCenter === 6 && cCenter === size - 7) ||
        (rCenter === size - 7 && cCenter === 6)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) mark(rCenter + dr, cCenter + dc);
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      mark(8, i);
      mark(i, 8);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  mark(4 * version + 9, 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return isFunction;
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function parseTerminalQrMatrix(rendered) {
  const clean = stripAnsi(rendered);
  const rawLines = clean.split(/\r?\n/);

  let bestBlock = [];
  let currentBlock = [];
  for (const line of rawLines) {
    if (/[█▀▄]/.test(line)) {
      currentBlock.push(line);
      if (currentBlock.length > bestBlock.length) bestBlock = currentBlock;
    } else {
      currentBlock = [];
    }
  }
  if (bestBlock.length === 0) {
    throw new Error("No terminal QR code blocks found in output.");
  }

  const firstTrimmed = bestBlock[0].trim();
  const inverted = firstTrimmed.length >= 21 && /^█+$/.test(firstTrimmed);
  const normalizedBlock = inverted
    ? bestBlock.map((line) => {
        const start = line.indexOf("█");
        const end = line.lastIndexOf("█");
        return start >= 0 && end >= start ? line.slice(start, end + 1) : line;
      })
    : bestBlock;

  const width = Math.max(...normalizedBlock.map((line) => [...line].length));
  const fullGrid = [];
  for (const line of normalizedBlock) {
    const chars = [...line];
    const topRow = new Array(width).fill(false);
    const bottomRow = new Array(width).fill(false);
    for (let c = 0; c < chars.length; c += 1) {
      const ch = chars[c];
      if (inverted) {
        if (ch === " ") {
          topRow[c] = true;
          bottomRow[c] = true;
        } else if (ch === "▄") {
          topRow[c] = true;
        } else if (ch === "▀") {
          bottomRow[c] = true;
        }
      } else {
        if (ch === "█") {
          topRow[c] = true;
          bottomRow[c] = true;
        } else if (ch === "▀") {
          topRow[c] = true;
        } else if (ch === "▄") {
          bottomRow[c] = true;
        }
      }
    }
    fullGrid.push(topRow, bottomRow);
  }

  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  for (let r = 0; r < fullGrid.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if (fullGrid[r][c]) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  if (maxR < minR || maxC < minC) {
    throw new Error("Terminal QR code matrix is empty.");
  }

  const matrix = [];
  for (let r = minR; r <= maxR; r += 1) {
    matrix.push(fullGrid[r].slice(minC, maxC + 1));
  }
  return matrix;
}

export function decodeQrMatrix(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) {
    throw new Error(`Unsupported QR matrix size: ${size}x${size}`);
  }

  let formatBits = 0;
  for (let i = 0; i <= 5; i += 1) if (matrix[8][i]) formatBits |= 1 << i;
  if (matrix[8][7]) formatBits |= 1 << 6;
  if (matrix[8][8]) formatBits |= 1 << 7;
  if (matrix[7][8]) formatBits |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (matrix[14 - i][8]) formatBits |= 1 << i;

  const unmaskedFormat = formatBits ^ 0x5412;
  const mask = (unmaskedFormat >>> 10) & 0b111;
  const isFunction = buildFunctionMask(version);
  const spec = VERSION_SPECS_L[version];

  const allCodewords = new Uint8Array(spec.total);
  let bitIndex = 0;
  const totalBits = spec.total * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (!isFunction[r][c] && bitIndex < totalBits) {
          const bit = matrix[r][c] !== maskBit(mask, r, c);
          if (bit) {
            allCodewords[bitIndex >>> 3] |= 1 << (7 - (bitIndex & 7));
          }
          bitIndex += 1;
        }
      }
    }
    upward = !upward;
  }

  const blockLengths = [];
  for (const [blockCount, dataWords] of spec.groups) {
    for (let b = 0; b < blockCount; b += 1) blockLengths.push(dataWords);
  }
  const dataBlocks = blockLengths.map((len) => new Uint8Array(len));
  const maxDataLen = Math.max(...blockLengths);
  let pos = 0;
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < dataBlocks.length; b += 1) {
      if (i < dataBlocks[b].length) {
        dataBlocks[b][i] = allCodewords[pos++];
      }
    }
  }

  const totalDataWords = blockLengths.reduce((a, b) => a + b, 0);
  const dataCodewords = new Uint8Array(totalDataWords);
  let offset = 0;
  for (const block of dataBlocks) {
    dataCodewords.set(block, offset);
    offset += block.length;
  }

  const readBits = (startBit, length) => {
    let val = 0;
    for (let i = 0; i < length; i += 1) {
      const bitPos = startBit + i;
      const bit = (dataCodewords[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
      val = (val << 1) | bit;
    }
    return val;
  };

  const mode = readBits(0, 4);
  if (mode !== 0b0100) {
    throw new Error(`Unsupported QR mode in decoder: ${mode}`);
  }
  const countBits = version <= 9 ? 8 : 16;
  const byteLength = readBits(4, countBits);
  const bytes = new Uint8Array(byteLength);
  let cursor = 4 + countBits;
  for (let i = 0; i < byteLength; i += 1) {
    bytes[i] = readBits(cursor, 8);
    cursor += 8;
  }
  return textDecoder.decode(bytes);
}

export function decodeTerminalQr(rendered) {
  return decodeQrMatrix(parseTerminalQrMatrix(rendered));
}
