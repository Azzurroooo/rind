import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { COLORS, logoSvg, markElements } from "./brand.mjs";

// Reuse the raster tooling already declared by Mobile; no runtime dependency.
const require = createRequire(new URL("../mobile/package.json", import.meta.url));
const sharp = require("sharp");
const root = new URL("../", import.meta.url);
const target = (path) => fileURLToPath(new URL(path, root));
const staticSvg = logoSvg();
const animatedSvg = logoSvg(true);

for (const path of ["assets/rind.svg", "frontend-web/public/rind.svg", "desktop/src/renderer/assets/brand-mark.svg"]) {
  await writeFile(target(path), staticSvg);
}
await writeFile(target("assets/rind-animated.svg"), animatedSvg);
await mkdir(target("design/icons"), { recursive: true });
for (const size of [16, 32, 48, 192, 512]) {
  await sharp(Buffer.from(staticSvg)).resize(size, size).png({ compressionLevel: 9 }).toFile(target(`design/icons/rind-${size}.png`));
}
await sharp(Buffer.from(staticSvg)).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(target("desktop/resources/icon.png"));

const socialSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="Rind — a lightweight AI coding agent">
  <rect width="1280" height="640" fill="${COLORS.paper}"/>
  <path d="M72 80H1208M72 560H1208" stroke="${COLORS.shell}" stroke-opacity=".2"/>
  <g transform="translate(96 184) scale(8.5)">${markElements()}</g>
  <g fill="${COLORS.shell}" font-family="Segoe UI, Arial, sans-serif">
    <text x="456" y="202" font-family="Consolas, monospace" font-size="19" letter-spacing="2">OPEN SOURCE · LOCAL FIRST</text>
    <text x="446" y="361" font-size="148" font-weight="600" letter-spacing="-6">Rind</text>
    <text x="456" y="420" font-size="32">A lightweight AI coding agent</text>
    <text x="456" y="480" font-family="Consolas, monospace" font-size="18">CLI · Desktop · Web · Mobile · Gateway</text>
    <text x="72" y="118" font-family="Consolas, monospace" font-size="16">A SMALL CORE. ROOM TO GROW.</text>
    <text x="1208" y="604" text-anchor="end" font-size="18">rindai.dev</text>
  </g>
</svg>\n`;
await writeFile(target("design/social-preview.svg"), socialSvg);
await sharp(Buffer.from(socialSvg)).png({ compressionLevel: 9 }).toFile(target("assets/rind-social-preview.png"));

const preview = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Rind · Logo</title>
  <link rel="icon" type="image/svg+xml" href="../assets/rind.svg"/>
  <style>
    :root { color-scheme: light; --shell: ${COLORS.shell}; --core: ${COLORS.core}; --paper: ${COLORS.paper}; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 48px 32px 32px; background: var(--paper); color: var(--shell); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
    main { max-width: 1120px; margin: auto; }
    header, footer, .card-heading, .controls, .sizes { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    header { padding-bottom: 24px; border-bottom: 1px solid color-mix(in srgb, var(--shell) 20%, transparent); }
    .lockup { display: flex; align-items: center; gap: 12px; }
    .lockup img { width: 32px; height: 32px; }
    .lockup strong { font-size: 24px; letter-spacing: -.6px; }
    .eyebrow { font: 12px Consolas, monospace; letter-spacing: 2px; }
    h1 { margin: 36px 0 8px; font-size: clamp(40px, 7vw, 72px); font-weight: 500; letter-spacing: -3px; line-height: 1.15; text-wrap: balance; }
    .intro { margin: 0 0 36px; opacity: .7; font-size: 16px; line-height: 1.7; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card { border: 1px solid color-mix(in srgb, var(--shell) 18%, transparent); border-radius: 24px; overflow: hidden; }
    .card-heading { padding: 20px 24px; font-size: 14px; }
    .card-heading span { font: 12px Consolas, monospace; opacity: .65; }
    .stage { height: 310px; display: grid; place-items: center; }
    .stage svg { width: 200px; height: 200px; }
    .card-note { padding: 0 24px 24px; margin: 0; font-size: 13px; line-height: 1.6; opacity: .72; }
    .motion { background: var(--shell); color: var(--core); border-color: var(--shell); }
    .motion .stage { background: var(--paper); margin: 0 24px 20px; border-radius: 12px; height: 266px; }
    .controls { justify-content: flex-start; padding: 0 24px 20px; gap: 8px; }
    button, select { font: inherit; font-size: 12px; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 6px; min-height: 44px; padding: 6px 12px; cursor: pointer; }
    button:hover, select:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    button:disabled, select:disabled { opacity: .45; cursor: default; }
    select option { background: var(--shell); color: var(--core); }
    .sizes { flex-wrap: wrap; padding: 28px 0; margin-top: 24px; border-bottom: 1px solid color-mix(in srgb, var(--shell) 20%, transparent); }
    .size { display: flex; gap: 12px; align-items: center; font: 12px Consolas, monospace; }
    .size img { display: block; }
    .palette { display: flex; gap: 20px; flex-wrap: wrap; font: 12px Consolas, monospace; }
    .swatch { width: 14px; height: 14px; display: inline-block; border-radius: 4px; vertical-align: middle; margin-right: 8px; }
    footer { padding-top: 24px; font-size: 12px; flex-wrap: wrap; }
    a { color: inherit; text-underline-offset: 4px; }
    @media (max-width: 680px) { body { padding: 24px 20px; } .grid { grid-template-columns: 1fr; } header .eyebrow { display: none; } h1 { letter-spacing: -1px; } .stage { height: 260px; } .stage svg { width: 160px; height: 160px; } }
  </style>
</head>
<body>
<main>
  <header><div class="lockup"><img src="../assets/rind.svg" alt=""/><strong>Rind</strong></div><span class="eyebrow">ONE MARK · EVERY SURFACE</span></header>
  <h1>同一切面，自然展开。</h1>
  <p class="intro">保留官网的深绿与浅黄绿。静态清晰，动态克制。</p>
  <div class="grid">
    <section class="card"><div class="card-heading"><strong>静态标志</strong><span>01 / STILL</span></div><div class="stage">${staticSvg}</div><p class="card-note">圆角外壳与内芯，一道斜切面。小尺寸也保持辨识。</p></section>
    <section class="card motion" id="motion"><div class="card-heading"><strong>切面展开</strong><span>02 / MOTION</span></div><div class="stage">${animatedSvg}</div><div class="controls"><button id="pause" type="button">暂停</button><button id="replay" type="button">重播</button><select id="speed" aria-label="播放速度"><option value="1">1× 速度</option><option value="0.1">0.1× 慢放</option></select></div><p class="card-note" id="motion-note">内芯沿切面轻轻向外移动，再回到原位。每轮 3.6 秒；减少动态时保持静态。</p></section>
  </div>
  <div class="sizes">${[16, 32, 48, 64].map((size) => `<div class="size"><img src="../assets/rind.svg" alt="${size} 像素 Rind 标志" width="${size}" height="${size}"/><span>${size} px</span></div>`).join("")}<div class="palette"><span><i class="swatch" style="background:var(--shell)"></i>${COLORS.shell}</span><span><i class="swatch" style="background:var(--core)"></i>${COLORS.core}</span></div></div>
  <footer><span>Rind · 官网与应用共用一个标志</span><span><a href="../assets/rind.svg">静态 SVG</a> · <a href="../assets/rind-animated.svg">动效 SVG</a> · <a href="icons/rind-512.png">PNG</a> · <a href="cli-logo/preview.html">终端预览</a></span></footer>
</main>
<script>
  const stage = document.querySelector('#motion .stage svg');
  const pause = document.querySelector('#pause');
  const replay = document.querySelector('#replay');
  const speed = document.querySelector('#speed');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = () => stage.getAnimations({ subtree: true });
  const syncMotion = () => {
    pause.disabled = replay.disabled = speed.disabled = reduced.matches;
    pause.textContent = reduced.matches ? '已减少动态' : '暂停';
    if (!reduced.matches) animations().forEach((animation) => animation.updatePlaybackRate(Number(speed.value)));
  };
  pause.addEventListener('click', () => {
    const paused = animations().some((animation) => animation.playState === 'paused');
    animations().forEach((animation) => paused ? animation.play() : animation.pause());
    pause.textContent = paused ? '暂停' : '继续';
  });
  replay.addEventListener('click', () => {
    animations().forEach((animation) => { animation.currentTime = 0; animation.play(); });
    pause.textContent = '暂停';
  });
  speed.addEventListener('change', () => animations().forEach((animation) => animation.updatePlaybackRate(Number(speed.value))));
  reduced.addEventListener('change', syncMotion);
  syncMotion();
</script>
</body>
</html>\n`;
await writeFile(target("design/rind-logo.html"), preview);
console.log("Generated shared SVGs, PNG exports, Desktop icon, and social artwork. Run npm --prefix mobile run icons for native assets.");
