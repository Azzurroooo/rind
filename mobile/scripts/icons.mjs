import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLORS, logoSvg } from "../../design/brand.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logo = Buffer.from(logoSvg());
async function icon(path, size, markSize, background = COLORS.paper) {
  const mark = await sharp(logo).resize(markSize).png().toBuffer();
  const canvas = sharp({ create: { width: size, height: size, channels: 4, background } }).composite([{ input: mark, gravity: "centre" }]);
  if (background !== "#00000000") canvas.removeAlpha();
  await canvas.png({ compressionLevel: 9 }).toFile(path);
}
const res = resolve(root, "android/app/src/main/res");
for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  for (const name of ["ic_launcher", "ic_launcher_round"]) await icon(`${res}/mipmap-${density}/${name}.png`, 48 * scale, 36 * scale);
  await icon(`${res}/mipmap-${density}/ic_launcher_foreground.png`, 108 * scale, 62 * scale, "#00000000");
}
for (const folder of await readdir(res)) {
  if (!folder.startsWith("drawable")) continue;
  if (!(await readdir(`${res}/${folder}`)).includes("splash.png")) continue;
  const path = `${res}/${folder}/splash.png`;
  const { width, height } = await sharp(path).metadata();
  const mark = await sharp(logo).resize(Math.round(Math.min(width, height) * .2)).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: COLORS.paper } }).composite([{ input: mark, gravity: "centre" }]).removeAlpha().png({ compressionLevel: 9 }).toFile(path);
}
const assets = resolve(root, "ios/App/App/Assets.xcassets");
await icon(`${assets}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 760);
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) await icon(`${assets}/Splash.imageset/${name}`, 2732, 480);
console.log("Generated Android and iOS icons/splash screens from the shared Rind logo.");
