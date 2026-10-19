import type { Configuration } from "electron-builder"
import { readRindVersion } from "./src/main/version"

const version = readRindVersion(new URL("../agent/version.py", import.meta.url))

const config: Configuration = {
  appId: "ai.rind.desktop",
  productName: "Rind",
  artifactName: "rind-desktop-${version}-${os}-${arch}.${ext}",
  extraMetadata: { version },
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*"],
  extraResources: [
    { from: "resources/runtime", to: "runtime" },
    { from: "resources/icon.ico", to: "icon.ico" },
    { from: "resources/icon.png", to: "icon.png" },
    { from: "../frontend-web/dist", to: "web" },
  ],
  win: {
    target: ["nsis"],
    icon: "resources/icon.ico",
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
