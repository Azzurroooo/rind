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
