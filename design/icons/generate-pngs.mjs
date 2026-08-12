import { chromium } from "playwright";

const rasterUrl = process.argv[2];
const sizes = [16, 32, 48, 192, 512];
const variants = ["amber", "color"];

const jobs = [];
for (const v of variants) {
  for (const s of sizes) {
    jobs.push([v, s, `${v}-${s}.png`]);
  }
}

const browser = await chromium.launch();
for (const [type, size, out] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.goto(`${rasterUrl}?type=${type}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log(`wrote ${out} (${size}x${size})`);
}
await browser.close();
