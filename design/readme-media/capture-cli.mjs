import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createCliOutputController } from '../../frontend-cli/lib/cli-output-controller.js';
import { createCliState } from '../../frontend-cli/lib/cli-state.js';
import { createTranscript } from '../../frontend-cli/lib/tui/transcript.js';
import { ComposerArea } from '../../frontend-cli/lib/components/composer-area.js';
import { promptText, promptPlaceholderText, inputHintText, questionMenuFrame, turnCompletedLine } from '../../frontend-cli/lib/rendering.js';
import { CURSOR_MARKER } from '../../frontend-cli/lib/tui/tui.js';
import { textWidth, stripAnsi } from '../../frontend-cli/lib/text-width.js';
import { setTheme } from '../../frontend-cli/lib/theme.js';
import { prompt, question, answer, calls, delivery, fileChange, info } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!option('browser-package') || !option('ffmpeg')) throw new Error('Pass --browser-package=/path/to/package.json and --ffmpeg=/path/to/ffmpeg.');
const { chromium } = createRequire(resolve(option('browser-package')))('@playwright/test');
const { Terminal } = createRequire(resolve(root, 'frontend-cli/package.json'))('@xterm/headless');
Object.defineProperty(process.stdout, 'isTTY', { value: true });
delete process.env.NO_COLOR;
setTheme('catppuccin-mocha');
const columns = 104, rows = 34, fps = 12, duration = 15;
const scratch = resolve(root, '.docs/readme-media-frames');
await mkdir(scratch, { recursive: true });

function frameAt(time) {
  const transcript = createTranscript();
  const output = createCliOutputController({ state: createCliState(), transcript, terminalUi: { requestRender() {} }, animateTools: false });
  output.showStartup(info);
  const typing = time < 1.8;
  const asking = time >= 3.5 && time < 6.9;
  const done = time >= 12.8;
  if (!typing) output.writeUserInput(prompt);
  const starts = [2.1, 3.5, 7.2, 9.5], ends = [3.3, 6.9, 9.1, 11.3];
  for (const [index, call] of calls.entries()) {
    if (time < starts[index]) continue;
    output.beginTool(call);
    if (index === 1) {
      output.beginQuestion(question);
      if (!asking) output.finishQuestion(question, answer);
    }
    if (time >= ends[index]) output.finishTool({ ...call, status: 'completed', duration_ms: call.duration_ms, result: JSON.stringify({ ok: true, data: call.data, meta: call.meta || {} }) }, index === 2 ? fileChange : undefined);
  }
  if (time >= 11.5) {
    output.assistantAppend(delivery.slice(0, Math.floor(delivery.length * Math.min(1, (time - 11.5) / 1.3))));
    if (done) { output.closeAssistant(); output.log(() => turnCompletedLine({ duration_ms: 12800 }, { completed: 4, failed: 0 })); }
  }
  output.setToolsExpanded(true);
  const input = typing ? prompt.slice(0, Math.floor(prompt.length * Math.max(0, time - .2) / 1.6)) : '';
  const menu = asking ? questionMenuFrame(question.options, time < 5.8 ? 0 : 1, '', false, undefined, columns) : null;
  const composer = new ComposerArea(() => ({
    prompt: promptText(info, {}, { running: !typing && !done, inputMode: asking ? 'question' : 'prompt', frame: Math.floor(time * 8), elapsedMs: Math.max(0, time * 1000 - 1800) }, columns),
    inputText: input, cursor: { line: 0, column: input.length },
    placeholder: asking ? '' : inputHintText(promptPlaceholderText()), menuText: menu?.text || '', showCaret: !asking && Math.floor(time * 2) % 2 === 0,
  })).render(columns);
  const history = transcript.render(columns);
  const lines = [...history.slice(-Math.max(0, rows - composer.length)), ...composer];
  let cursor = null;
  const cleaned = lines.map((line, y) => {
    const at = line.indexOf(CURSOR_MARKER);
    if (at !== -1) cursor = { x: textWidth(line.slice(0, at)), y };
    return line.replaceAll(CURSOR_MARKER, '');
  });
  if (cleaned.some(line => textWidth(line) > columns)) throw new Error(`Overflow at ${time}s`);
  return { lines: cleaned, cursor };
}

const browser = await chromium.launch();
const evidence = {};
try {
  const page = await browser.newPage({ viewport: { width: 1152, height: 856 }, deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0"><canvas width="1152" height="856"></canvas></body></html>');
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true });
  for (let frame = 0; frame < fps * duration; frame++) {
    const time = frame / fps;
    const { lines, cursor } = frameAt(time);
    terminal.reset();
    await new Promise(done => terminal.write(lines.map((line, y) => `\x1b[${y + 1};1H${line}`).join(''), done));
    const cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const cell = terminal.buffer.active.getLine(y)?.getCell(x);
      if (cell) cells.push({ x, y, text: cell.getChars(), fg: cell.isFgRGB() ? cell.getFgColor() : null, bg: cell.isBgRGB() ? cell.getBgColor() : null, bold: !!cell.isBold(), dim: !!cell.isDim() });
    }
    await page.evaluate(({ cells, cursor }) => {
      const ctx = document.querySelector('canvas').getContext('2d');
      ctx.fillStyle = '#1e1e2e'; ctx.fillRect(0, 0, 1152, 856);
      ctx.fillStyle = '#181825'; ctx.fillRect(0, 0, 1152, 42);
      ctx.font = '13px Consolas, monospace'; ctx.fillStyle = '#a6adc8';
      ctx.fillText('RIND CLI / UNICODE TESTS', 28, 26);
      ctx.textAlign = 'right'; ctx.fillText('SIMULATED DEMO · 15s', 1124, 26); ctx.textAlign = 'left';
      const font = '17px Consolas, "Liberation Mono", monospace'; ctx.font = font;
      const cw = ctx.measureText('M').width, ch = 23, left = 36, top = 56;
      const hex = color => `#${color.toString(16).padStart(6, '0')}`;
      const box = { '│': 'ud', '─': 'lr', '├': 'udr', '└': 'ur', '┌': 'dr', '┐': 'dl', '┘': 'ul', '┬': 'dlr', '┴': 'ulr', '┼': 'udlr' };
      for (const cell of cells) {
        const x = left + cell.x * cw, y = top + cell.y * ch;
        if (cell.bg !== null) { ctx.fillStyle = hex(cell.bg); ctx.fillRect(x, y, cw + .2, ch); }
        ctx.fillStyle = cell.fg === null ? '#cdd6f4' : hex(cell.fg); ctx.globalAlpha = cell.dim ? .65 : 1;
        if (box[cell.text]) {
          ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.beginPath();
          for (const arm of box[cell.text]) { ctx.moveTo(x + cw / 2, y + ch / 2); ctx.lineTo(arm === 'l' ? x : arm === 'r' ? x + cw : x + cw / 2, arm === 'u' ? y : arm === 'd' ? y + ch : y + ch / 2); }
          ctx.stroke();
        } else { ctx.font = `${cell.bold ? 'bold ' : ''}${font}`; ctx.fillText(cell.text, x, y + 17); }
        ctx.globalAlpha = 1;
      }
      if (cursor) { ctx.fillStyle = '#cdd6f4'; ctx.fillRect(left + cursor.x * cw, top + cursor.y * ch + 19, cw, 2); }
    }, { cells, cursor });
    await page.screenshot({ path: resolve(scratch, `${String(frame).padStart(4, '0')}.png`) });
    if ([0, 48, 72, 102, 132, 168].includes(frame)) evidence[time] = lines.map(stripAnsi).join('\n');
  }
  terminal.dispose();
} finally { await browser.close(); }

const ffmpeg = resolve(option('ffmpeg'));
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', resolve(scratch, '%04d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(root, 'assets/rind-cli-demo.mp4')]);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', resolve(root, 'assets/rind-cli-demo.mp4'), '-filter_complex', '[0:v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', resolve(root, 'assets/rind-cli-demo.gif')]);
await writeFile(new URL('cli-capture.json', import.meta.url), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), duration, fps, columns, rows, resolution: [1152, 856], renderer: 'frontend-cli/lib/cli-output-controller.js + questionMenuFrame + ComposerArea + xterm cells', simulated: true, evidence }, null, 2) + '\n');
process.stdout.write('Captured 15-second native CLI demo (MP4 + GIF).\n');
