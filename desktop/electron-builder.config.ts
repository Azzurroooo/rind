import type { Configuration } from "electron-builder"

const config: Configuration = {
  appId: "ai.rind.desktop",
  productName: "Rind",
  artifactName: "rind-desktop-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  win: {
    target: ["nsis"],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
  },
}

export default config
