import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('../../', import.meta.url));
const browserPackage = process.argv.find(arg => arg.startsWith('--browser-package='))?.slice(18);
if (!browserPackage) throw new Error('Pass --browser-package=/path/to/package.json.');
const require = createRequire(resolve(browserPackage));
const { chromium } = require('@playwright/test');
const { marked } = await import(pathToFileURL(require.resolve('marked')).href);
const scratch = resolve(root, '.docs/readme-preview');
await mkdir(scratch, { recursive: true });
const cli = JSON.parse(await readFile(new URL('cli-capture.json', import.meta.url), 'utf8'));
assert.equal(cli.duration, 15);
assert.equal(cli.resolution[0] * 9, cli.resolution[1] * 16, 'CLI video must be 16:9');
assert.equal(cli.chrome, 'terminal-tab-and-window-controls');
assert.deepEqual(cli.overlays, []);
const captureSource = await readFile(new URL('capture-cli.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(captureSource, /RIND CLI \/ UNICODE TESTS|SIMULATED DEMO/);
const gifEncoder = captureSource.split('\n').find(line => line.startsWith('execFileSync(ffmpeg,') && line.includes('assets/rind-cli-demo.gif'));
assert.ok(gifEncoder?.includes("resolve(scratch, '%04d.png')"), 'GIF must be encoded directly from lossless frames');
assert.doesNotMatch(gifEncoder, /scale=|assets\/rind-cli-demo\.mp4/, 'GIF must not be downscaled or transcoded from MP4');
assert.match(cli.evidence['4'], /Which Unicode cases/);
assert.match(cli.evidence['6'], /› Emoji, combining marks/);
assert.match(cli.evidence['14'], /A: Emoji, combining marks & CJK/);
assert.match(cli.evidence['14'], /4 tests pass/);
for (const frame of Object.values(cli.evidence)) {
  assert.match(frame, /GPT-6-Astra/);
  assert.doesNotMatch(frame, /glm-4\.7/);
}
const documents = {};
for (const name of ['README.md', 'README.zh-CN.md']) {
  const text = await readFile(resolve(root, name), 'utf8');
  assert.ok(text.indexOf('rind-cli-demo.gif') < text.indexOf('agents-management.png'));
  assert.ok(text.indexOf('agents-management.png') < text.indexOf('rind-clients.png'));
  assert.ok(!text.includes('rind agents team create'));
  assert.doesNotMatch(text, /<details>|<summary>/);
  assert.match(text, /python -m pip install -r requirements-runtime\.txt/);
  assert.match(text, /npm run build --prefix agent-management/);
  assert.match(text, /node frontend-cli\/bin\/rind\.js/);
  for (const match of text.matchAll(/(?:\]\(|(?:href|src)=")([^\s"\)]+)/g)) {
    const link = match[1];
    if (/^(https?:|#)/.test(link)) continue;
    const file = resolve(root, decodeURIComponent(link.split('#')[0]));
    assert.ok(file.startsWith(root), `Out of scope: ${link}`);
    await stat(file);
  }
  documents[name] = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0;color:#1f2328;background:white;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}article{max-width:980px;padding:36px;margin:auto}img{max-width:100%;height:auto}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:.3em;line-height:1.25}h2{margin-top:32px}h3{line-height:1.25}a{color:#0969da;text-decoration:none}p,ul{margin-top:0;margin-bottom:16px}pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto}code{font-family:Consolas,monospace}summary{cursor:pointer}li+li{margin-top:8px}sub{font-size:12px}@media(max-width:600px){article{padding:20px}}
    </style></head><body><article>${marked.parse(text)}</article></body></html>`;
}
const mime = { '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (documents[pathname.slice(1)]) return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(documents[pathname.slice(1)]);
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(resolve(root) + sep)) return response.writeHead(403).end();
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch();
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage();
  await page.route('https://**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="82" height="20"><rect width="82" height="20" rx="3" fill="#555"/><text x="8" y="14" font-size="11" fill="white">badge preview</text></svg>' }));
  for (const name of Object.keys(documents)) for (const width of [1060, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/${name}`);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    const demo = await page.locator('img[src="assets/rind-cli-demo.gif"]').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
    assert.deepEqual([demo.width, demo.height], cli.resolution, 'Inline CLI demo must preserve the full-resolution 16:9 frames');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}px`);
    await page.screenshot({ path: resolve(scratch, `${name}-${width}.png`), fullPage: true });
  }
  await page.setContent(`<video muted src="${base}/assets/rind-cli-demo.mp4"></video>`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const video = await page.locator('video').evaluate(async video => {
    await video.play();
    video.pause();
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  });
  assert.equal(video.duration, 15);
  assert.equal(video.width * 9, video.height * 16, 'Encoded CLI video must be 16:9');
  assert.deepEqual([video.width, video.height], cli.resolution);
  process.stdout.write(`README links, media order, English/Chinese 1060px/390px layouts, and H.264 playback verified: ${JSON.stringify(video)}\n`);
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
