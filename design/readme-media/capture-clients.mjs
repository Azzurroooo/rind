// Capture actual clients with local fixture responses; no Worker or provider runs.
import { createRequire } from 'node:module';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { rpcResult, delivery, calls, session } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!option('website')) throw new Error('Pass --website=/path/to/rind-web (built native Desktop demo and Playwright dependency).');
const website = resolve(option('website'));
const { chromium } = createRequire(resolve(website, 'package.json'))('@playwright/test');
const webRequire = createRequire(resolve(root, 'frontend-web/package.json'));
const { createServer: createViteServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const scratch = resolve(root, '.docs/readme-client-captures');
await mkdir(scratch, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function serve(directory) {
  const server = createHttpServer(async (request, response) => {
    try {
      const file = resolve(directory, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!file.startsWith(directory + sep)) return response.writeHead(403).end();
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server;
}
const origin = server => `http://127.0.0.1:${(server.httpServer || server).address().port}`;
let browser, desktopServer, web, mobile, imageServer;
const errors = [], rpcMethods = new Set();
const sockets = [];
function replayToolEvents(socket) {
  let sequence = 1;
  const send = event => socket.send(JSON.stringify({ kind: 'event', session_id: session.id, turn_id: 'demo-turn', sequence: sequence++, durability: 'durable', event }));
  for (const call of calls) {
    send({ type: 'tool_requested', tool_call_id: call.tool_call_id, tool_name: call.tool_name, args_preview: JSON.stringify(call.arguments) });
    send({ type: 'tool_result', tool_call_id: call.tool_call_id, tool_name: call.tool_name, status: 'completed', duration_ms: call.duration_ms, result: JSON.stringify({ ok: true, tool: call.tool_name, data: call.data, meta: call.meta || {} }) });
  }
  send({ type: 'turn_completed', duration_ms: 12800 });
}
try {
  desktopServer = await serve(resolve(website, 'public/demos/desktop'));
  web = await createViteServer({ root: resolve(root, 'frontend-web'), configFile: resolve(root, 'frontend-web/vite.config.js'), server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'warn' });
  mobile = await createViteServer({ root: resolve(root, 'mobile'), configFile: resolve(root, 'mobile/vite.config.js'), server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'warn' });
  await web.listen(); await mobile.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/ticket', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ticket: 'fictional-capture-ticket' }) }));
  // Any application socket is intercepted, including Mobile's configured host.
  // No request is forwarded to a real runtime. Vite HMR sockets are separate.
  await context.routeWebSocket(url => url.pathname === '/ws', socket => {
    sockets.push(socket);
    socket.onMessage(raw => {
      const request = JSON.parse(raw);
      rpcMethods.add(request.method);
      try { socket.send(JSON.stringify({ kind: 'response', request_id: request.request_id, result: rpcResult(request.method) })); }
      catch (error) { errors.push(error.message); socket.send(JSON.stringify({ kind: 'response', request_id: request.request_id, error: { message: error.message } })); }
    });
  });
  const desktopPage = await context.newPage();
  await desktopPage.setViewportSize({ width: 1080, height: 800 });
  await desktopPage.goto(`${origin(desktopServer)}/index.html?scene=0`);
  await desktopPage.waitForFunction(() => document.getElementById('message-stream')?.textContent.includes('All 4 tests pass'));
  await desktopPage.evaluate(() => document.fonts.ready);
  await desktopPage.screenshot({ path: resolve(scratch, 'desktop.png'), animations: 'disabled' });

  const webPage = await context.newPage();
  await webPage.setViewportSize({ width: 1000, height: 800 });
  await webPage.addInitScript(() => {
    sessionStorage.setItem('rind_token', 'fictional-capture-token');
    sessionStorage.setItem('rind_credential_server', `ws://${location.host}/ws`);
  });
  await webPage.goto(origin(web));
  await webPage.getByText('All 4 tests pass.', { exact: false }).waitFor();
  // Use the actual protocol's replay/live overlap to retain argument previews.
  replayToolEvents(sockets.at(-1));
  await webPage.locator('.work-segment-head').filter({ hasText: 'tokenizer.test.js' }).waitFor();
  await webPage.evaluate(() => document.fonts.ready);
  const segment = webPage.locator('.work-segment-head').first();
  if (await segment.count() && await segment.getAttribute('aria-expanded') === 'false') await segment.click();
  await webPage.locator('.transcript').evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0; }));
  await webPage.screenshot({ path: resolve(scratch, 'web.png'), animations: 'disabled' });

  const appPage = await context.newPage();
  await appPage.setViewportSize({ width: 390, height: 780 });
  await appPage.goto(origin(mobile));
  await appPage.getByRole('button', { name: 'Add computer', exact: true }).click();
  await appPage.getByLabel('Computer name', { exact: false }).fill('My workspace');
  await appPage.getByLabel('Server address', { exact: false }).fill('http://127.0.0.1:8765');
  await appPage.getByLabel('Access code').fill('fictional-capture-token');
  await appPage.getByRole('button', { name: 'Connect', exact: true }).click();
  await appPage.getByText('All 4 tests pass.', { exact: false }).waitFor();
  replayToolEvents(sockets.at(-1));
  await appPage.locator('.work-segment-head').filter({ hasText: 'tokenizer.test.js' }).waitFor();
  await appPage.evaluate(() => document.fonts.ready);
  await appPage.screenshot({ path: resolve(scratch, 'app.png'), animations: 'disabled' });
  if (errors.length) throw new Error(errors.join('\n'));

  imageServer = await serve(scratch);
  const imageOrigin = origin(imageServer);
  const collage = await browser.newPage({ viewport: { width: 2160, height: 1100 }, deviceScaleFactor: 1 });
  await collage.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;background:#f6f5f1;color:#252623;font-family:"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    header{padding:58px 64px 0;display:flex;justify-content:space-between;align-items:end}h1{font-size:44px;letter-spacing:-1.8px;font-weight:500;margin:0;text-wrap:balance}header p{font-size:18px;color:#777971;margin:0 0 6px}
    main{padding:56px 64px 0;display:grid;grid-template-columns:820px 820px 312px;gap:38px;align-items:start}.label{display:flex;justify-content:space-between;align-items:center;margin:0 0 18px}h2{margin:0;font-size:23px;font-weight:600;letter-spacing:-.5px}.label small{color:#777971;font-size:14px}
    .window{border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px #00000012,0 8px 24px #00000009;background:white}.chrome{height:35px;padding:0 15px;display:flex;align-items:center;gap:7px;background:#eeede8;color:#8a8d84;font-size:11px}.dot{width:7px;height:7px;border-radius:50%;background:#b7b9b0}.address{margin-left:14px;letter-spacing:.6px}.window img{width:100%;display:block;outline:1px solid #0000001a;outline-offset:-1px}
    .phone{padding:7px;border-radius:30px;background:#292c27;box-shadow:0 0 0 1px #00000012,0 8px 24px #0000000c}.phone img{width:100%;display:block;border-radius:23px}.caption{font-size:17px;color:#777971;line-height:1.6;margin:20px 0 0;text-wrap:pretty}footer{position:absolute;bottom:44px;left:64px;right:64px;border-top:1px solid #00000012;padding-top:22px;display:flex;justify-content:space-between;font-size:14px;color:#777971}
    </style></head><body><header><h1>One core. More ways to work.</h1><p>Desktop / Web / App</p></header><main>
    <section><div class="label"><h2>Desktop</h2><small>LOCAL WORKSPACE</small></div><div class="window"><div class="chrome"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="address">RIND DESKTOP</span></div><img src="${imageOrigin}/desktop.png" /></div><p class="caption">Conversations, files and tools. At your desk.</p></section>
    <section><div class="label"><h2>Web</h2><small>BROWSER ACCESS</small></div><div class="window"><div class="chrome"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="address">YOUR WORKER · CONNECTED</span></div><img src="${imageOrigin}/web.png" /></div><p class="caption">Connect to your host. Work in your browser.</p></section>
    <section><div class="label"><h2>App</h2><small>MOBILE</small></div><div class="phone"><img src="${imageOrigin}/app.png" /></div><p class="caption">Your workspace,<br />within reach.</p></section></main><footer><span>RIND · LIGHT BY DESIGN</span><span>Actual client renderers · sample conversations · mobile browser capture</span></footer></body></html>`);
  await collage.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await collage.screenshot({ path: resolve(root, 'assets/rind-clients.png'), animations: 'disabled' });
  await writeFile(new URL('clients-capture.json', import.meta.url), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), desktop: 'rind-web/public/demos/desktop (real Desktop renderer, sample preload API)', web: 'frontend-web/src/main.jsx', app: 'mobile/src/main.jsx (Capacitor browser renderer, local ticket/socket fixtures)', mobileNativeCapabilitiesTested: false, modelCalls: 0, rpcMethods: [...rpcMethods], resolution: [2160, 1100], delivery }, null, 2) + '\n');
  process.stdout.write('Captured Desktop / Web / App collage.\n');
} finally {
  await browser?.close();
  await web?.close(); await mobile?.close();
  if (desktopServer) await new Promise(done => desktopServer.close(done));
  if (imageServer) await new Promise(done => imageServer.close(done));
}
