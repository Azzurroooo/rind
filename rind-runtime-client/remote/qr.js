// Zero-dependency ISO/IEC 18004 QR Code encoder, terminal half-block renderer,
// SVG renderer, and terminal QR decoder.

const VERSION_SPECS_L = [
  null,
  { total: 26, ecPerBlock: 7, groups: [[1, 19]] },
  { total: 44, ecPerBlock: 10, groups: [[1, 34]] },
  { total: 70, ecPerBlock: 15, groups: [[1, 55]] },
  { total: 100, ecPerBlock: 20, groups: [[1, 80]] },
  { total: 134, ecPerBlock: 26, groups: [[1, 108]] },
  { total: 172, ecPerBlock: 18, groups: [[2, 68]] },
  { total: 196, ecPerBlock: 20, groups: [[2, 78]] },
  { total: 242, ecPerBlock: 24, groups: [[2, 97]] },
  { total: 292, ecPerBlock: 30, groups: [[2, 116]] },
  { total: 346, ecPerBlock: 18, groups: [[2, 68], [2, 69]] },
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

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    GF_EXP[index] = GF_EXP[index - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[index];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLength) {
  const gen = rsGeneratorPoly(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j += 1) {
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return remainder;
}

function dataCapacityBytes(version) {
  const spec = VERSION_SPECS_L[version];
  const totalDataCodewords = spec.groups.reduce((sum, [count, dataWords]) => sum + count * dataWords, 0);
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((totalDataCodewords * 8 - 4 - countBits) / 8);
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    if (byteLength <= dataCapacityBytes(version)) return version;
  }
  throw new Error(`QR payload too large (${byteLength} bytes).`);
}

function encodeDataCodewords(bytes, version) {
  const spec = VERSION_SPECS_L[version];
  const totalDataCodewords = spec.groups.reduce((sum, [count, dataWords]) => sum + count * dataWords, 0);
  const totalBitsCapacity = totalDataCodewords * 8;
  const bits = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >>> i) & 1);
    }
  };

  // Byte mode indicator (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);

  const terminator = Math.min(4, totalBitsCapacity - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalDataCodewords);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i += 1) {
    let value = 0;
    for (let b = 0; b < 8; b += 1) value = (value << 1) | bits[i * 8 + b];
    codewords[i] = value;
  }
  const pads = [0xec, 0x11];
  for (let i = byteCount; i < totalDataCodewords; i += 1) {
    codewords[i] = pads[(i - byteCount) % 2];
  }
  return codewords;
}

function interleaveCodewords(dataCodewords, version) {
  const spec = VERSION_SPECS_L[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [blockCount, dataWords] of spec.groups) {
    for (let b = 0; b < blockCount; b += 1) {
      const block = dataCodewords.subarray(offset, offset + dataWords);
      offset += dataWords;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ecPerBlock));
    }
  }

  const result = new Uint8Array(spec.total);
  let pos = 0;
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result[pos++] = block[i];
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      result[pos++] = block[i];
    }
  }
  return result;
}

function createBaseMatrix(version) {
  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    modules[row][col] = Boolean(dark);
    isFunction[row][col] = true;
  };

  const drawFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const dark =
          r >= 0 &&
          r <= 6 &&
          c >= 0 &&
          c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setFunctionModule(top + r, left + c, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  const align = ALIGNMENT_COORDS[version];
  for (const rCenter of align) {
    for (const cCenter of align) {
      if (
        (rCenter === 6 && cCenter === 6) ||
        (rCenter === 6 && cCenter === size - 7) ||
        (rCenter === size - 7 && cCenter === 6)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(rCenter + dr, cCenter + dc, dark);
        }
      }
    }
  }

  // Reserve format information areas and dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(4 * version + 9, 8, true);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  return { size, modules, isFunction };
}

function drawFormatBits(modules, size, mask) {
  // ECC Level L indicator is 01
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) modules[8][i] = ((bits >>> i) & 1) !== 0;
  modules[8][7] = ((bits >>> 6) & 1) !== 0;
  modules[8][8] = ((bits >>> 7) & 1) !== 0;
  modules[7][8] = ((bits >>> 8) & 1) !== 0;
  for (let i = 9; i < 15; i += 1) modules[14 - i][8] = ((bits >>> i) & 1) !== 0;

  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = ((bits >>> i) & 1) !== 0;
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = ((bits >>> i) & 1) !== 0;
  modules[size - 8][8] = true;
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

function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  // Rule 1: adjacent modules in row/col
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = modules[r][c];
      if (modules[r][c + 1] === color && modules[r + 1][c] === color && modules[r + 1][c + 1] === color) {
        score += 3;
      }
    }
  }

  return score;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

export function encodeQrMatrix(text) {
  const bytes = textEncoder.encode(String(text));
  const version = chooseVersion(bytes.length);
  const dataCodewords = encodeDataCodewords(bytes, version);
  const allCodewords = interleaveCodewords(dataCodewords, version);
  const { size, modules, isFunction } = createBaseMatrix(version);

  let bitIndex = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (!isFunction[r][c]) {
          const dark =
            bitIndex < totalBits
              ? ((allCodewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
              : false;
          modules[r][c] = dark;
          bitIndex += 1;
        }
      }
    }
    upward = !upward;
  }

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row, r) =>
      row.map((val, c) => (isFunction[r][c] ? val : val !== maskBit(mask, r, c))),
    );
    drawFormatBits(candidate, size, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return bestMatrix;
}

export function renderTerminalQr(text, { margin = 2, invert = true } = {}) {
  const matrix = Array.isArray(text) ? text : encodeQrMatrix(text);
  const size = matrix.length;
  const total = size + margin * 2;
  const isDark = (r, c) => {
    const mr = r - margin;
    const mc = c - margin;
    return mr >= 0 && mr < size && mc >= 0 && mc < size ? Boolean(matrix[mr][mc]) : false;
  };
  const cell = (r, c) => (invert ? !isDark(r, c) : isDark(r, c));
  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c += 1) {
      const top = cell(r, c);
      const bottom = r + 1 < total ? cell(r + 1, c) : Boolean(invert);
      if (top && bottom) line += "█";
      else if (top) line += "▀";
      else if (bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function renderSvgQrDataUrl(text, { margin = 2, size: pixelSize = 192 } = {}) {
  const matrix = Array.isArray(text) ? text : encodeQrMatrix(text);
  const size = matrix.length;
  const total = size + margin * 2;
  let path = "";
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c]) {
        path += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="#0c0e12"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function parseTerminalQrMatrix(rendered) {
  const clean = stripAnsi(rendered);
  const rawLines = clean.split(/\r?\n/);

  // Find the largest contiguous block of lines containing QR half-block characters
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

  // Detect inverted polarity (quiet zone rendered as solid '█' blocks)
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

  // Read format bits from top-left copy
  let formatBits = 0;
  for (let i = 0; i <= 5; i += 1) if (matrix[8][i]) formatBits |= 1 << i;
  if (matrix[8][7]) formatBits |= 1 << 6;
  if (matrix[8][8]) formatBits |= 1 << 7;
  if (matrix[7][8]) formatBits |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (matrix[14 - i][8]) formatBits |= 1 << i;

  const unmaskedFormat = formatBits ^ 0x5412;
  const mask = (unmaskedFormat >>> 10) & 0b111;
  const { isFunction } = createBaseMatrix(version);
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

  // De-interleave data blocks
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
