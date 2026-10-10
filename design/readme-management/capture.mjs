// Capture the actual CLI renderer using an in-memory example team. No services,
// workspaces, provider calls or application settings are created or changed.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { emptyAgentsSnapshot, organizationRows, sidebarRows, teamSessions } from '../../frontend-cli/lib/agents-model.js';
import { renderAgents } from '../../frontend-cli/lib/agents-view.js';
import { setTheme } from '../../frontend-cli/lib/theme.js';
import { textWidth, stripAnsi } from '../../frontend-cli/lib/text-width.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliRequire = createRequire(resolve(root, 'frontend-cli/package.json'));
const browserPackage = process.argv.find(arg => arg.startsWith('--browser-package='))?.slice(18);
if (!browserPackage) throw new Error('Pass --browser-package=/path/to/package.json for an installed @playwright/test package.');
const { chromium } = createRequire(resolve(browserPackage))('@playwright/test');
const { Terminal } = cliRequire('@xterm/headless');
Object.defineProperty(process.stdout, 'isTTY', { value: true });
delete process.env.NO_COLOR;
setTheme('catppuccin-mocha');

const now = Date.parse('2026-10-09T09:00:00Z');
const stamp = new Date(now).toISOString();
const snapshot = emptyAgentsSnapshot();
snapshot.teams.push({ id: 'product', name: 'Product', leaderAgentId: 'lead', createRoot: '~/product' });
const members = [
  ['lead', 'Lead', 'Team lead', null, 'Delegated', 'Ship the login page'],
  ['dev', 'Development', 'Engineering', 'lead', 'Delegated', 'Build the login experience'],
  ['web', 'Frontend', 'UI', 'dev', 'Working', 'Implement the login UI'],
  ['api', 'Backend', 'API', 'dev', 'Working', 'Build the authentication API'],
  ['qa', 'QA', 'Quality', 'lead', 'Delegated', 'Verify login behavior'],
  ['unit', 'Unit tests', 'Regression', 'qa', 'Working', 'Add login regression tests'],
  ['e2e', 'E2E tests', 'Browser', 'qa', 'Working', 'Check browser login flows'],
  ['review', 'Reviewer', 'Code review', 'lead', 'Working', 'Review the implementation'],
];
snapshot.live = [];
for (const [id, name, position, parent, status, brief] of members) {
  snapshot.agents.push({ id, name, canonicalWorkspace: `~/product/${id}` });
  snapshot.memberships.push({ teamId: 'product', agentId: id, position, status, ...(parent ? { reportsToAgentId: parent } : {}) });
  snapshot.tasks.push({ id: `task-${id}`, teamId: 'product', assigneeAgentId: id, createdBy: parent || 'user', brief,
    status: status === 'Delegated' ? 'blocked' : 'running',
    ...(parent ? { parentTaskId: `task-${parent}` } : {}),
    ...(status === 'Delegated' ? { blockedOn: { responder: 'children', action: 'Waiting for member reports.' } } : {}),
  });
  snapshot.sessions.push({ id: `session-${id}`, runtimeSessionId: `runtime-${id}`, agentId: id, teamId: 'product', origin: 'managed', taskId: `task-${id}`, status, lastActivity: stamp });
  snapshot.live.push({ id: `runtime-${id}`, title: brief, workspace: `~/product/${id}`, turn: status === 'Working' ? 'running' : 'idle', watchers: 0, startedAt: stamp });
  if (status === 'Working') snapshot.runs.push({ id: `run-${id}`, sessionId: `session-${id}`, taskId: `task-${id}`, status: 'running', startedAt: stamp });
}
const columns = 132, rows = 26;
const view = { snapshot, page: { kind: 'team', teamId: 'product', tab: 'org' },
  entries: [{ id: 'add-member', kind: 'add-member', teamId: 'product', title: 'Add member' }, ...organizationRows(snapshot, 'product', teamSessions(snapshot, 'product'), { now })],
  sidebar: sidebarRows(snapshot), selectedId: 'm:web', navId: 'product', focus: 'main',
  pageKey: 'team:product:org', scroll: {}, query: '', filter: 'All', connection: 'connected', returnTo: { own: true },
};
const lines = renderAgents(view, columns, rows, now);
if (lines.some(line => textWidth(line) > columns)) throw new Error('Native frame exceeds the terminal width.');
const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true });
await new Promise(done => terminal.write(lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join(''), done));
const cells = [];
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < columns; x++) {
    const cell = terminal.buffer.active.getLine(y)?.getCell(x);
    if (!cell) continue;
    cells.push({ x, y, text: cell.getChars(), fg: cell.isFgRGB() ? cell.getFgColor() : null,
      bg: cell.isBgRGB() ? cell.getBgColor() : null, bold: !!cell.isBold(), dim: !!cell.isDim() });
  }
}
terminal.dispose();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><html><body style="margin:0"><canvas></canvas></body></html>');
  const size = await page.evaluate(({ cells, columns, rows }) => {
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const font = '16px Consolas, "Liberation Mono", monospace';
    ctx.font = font;
    const cw = ctx.measureText('M').width, ch = 21, pad = 24;
    const width = Math.ceil(columns * cw + pad * 2), height = rows * ch + pad * 2;
    canvas.width = width * 2; canvas.height = height * 2;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.scale(2, 2);
    ctx.fillStyle = '#1e1e2e'; ctx.fillRect(0, 0, width, height);
    const hex = color => `#${color.toString(16).padStart(6, '0')}`;
    // Terminal emulators draw box glyphs to the cell edges, without text leading.
    const box = { '│': 'ud', '─': 'lr', '├': 'udr', '└': 'ur', '┌': 'dr', '┐': 'dl', '┘': 'ul', '┬': 'dlr', '┴': 'ulr', '┼': 'udlr' };
    for (const cell of cells) {
      const x = pad + cell.x * cw, y = pad + cell.y * ch;
      if (cell.bg !== null) { ctx.fillStyle = hex(cell.bg); ctx.fillRect(x, y, cw + .2, ch); }
      ctx.fillStyle = cell.fg === null ? '#cdd6f4' : hex(cell.fg);
      ctx.globalAlpha = cell.dim ? .65 : 1;
      if (box[cell.text]) {
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.beginPath();
        for (const arm of box[cell.text]) {
          ctx.moveTo(x + cw / 2, y + ch / 2);
          ctx.lineTo(arm === 'l' ? x : arm === 'r' ? x + cw : x + cw / 2, arm === 'u' ? y : arm === 'd' ? y + ch : y + ch / 2);
        }
        ctx.stroke();
      } else { ctx.font = `${cell.bold ? 'bold ' : ''}${font}`; ctx.fillText(cell.text, x, y + 16); }
      ctx.globalAlpha = 1;
    }
    return { width, height };
  }, { cells, columns, rows });
  await page.setViewportSize(size);
  await page.locator('canvas').screenshot({ path: resolve(root, 'assets/agents-management.png') });
  await writeFile(new URL('capture.json', import.meta.url), JSON.stringify({
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    renderer: 'frontend-cli/lib/agents-view.js', theme: 'catppuccin-mocha', columns, rows,
    data: 'Fictional example team; native renderer and xterm cell interpretation. No model calls.',
    text: lines.map(stripAnsi),
  }, null, 2) + '\n');
  console.log(`Captured native Agents Management: ${size.width} × ${size.height} CSS pixels, 2x PNG.`);
} finally { await browser.close(); }
