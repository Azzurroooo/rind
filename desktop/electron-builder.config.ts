import type { Configuration } from "electron-builder"
import { readFileSync } from "node:fs"

const version = readFileSync(new URL("../agent/version.py", import.meta.url), "utf8").match(
  /^__version__ = "([^"]+)"$/m,
)?.[1]

if (!version) throw new Error("Rind version is missing from agent/version.py.")

const config: Configuration = {
  appId: "ai.rind.desktop",
  productName: "Rind",
  artifactName: "rind-desktop-${version}-${os}-${arch}.${ext}",
  extraMetadata: { version },
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  win: {
    target: ["nsis"],
    icon: "resources/icon.png",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
  },
  mac: {
    icon: "resources/icon.png",
  },
  linux: {
    target: ["AppImage"],
    icon: "resources/icon.png",
  },
}

export default config
