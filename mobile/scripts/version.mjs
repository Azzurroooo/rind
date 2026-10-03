import { readFile, writeFile } from "node:fs/promises";
const source = await readFile(new URL("../../agent/version.py", import.meta.url), "utf8");
const version = source.match(/__version__ = "([^"]+)"/)?.[1];
if (!version) throw new Error("Could not read the Rind version.");
const project = new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url);
const text = await readFile(project, "utf8");
await writeFile(project, text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version.split("-")[0]};`));
console.log(`Native version: ${version}`);
