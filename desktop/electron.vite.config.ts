import { defineConfig } from "electron-vite"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = dirname(fileURLToPath(import.meta.url))
const rendererEntry = fileURLToPath(new URL("./src/renderer/index.html", import.meta.url))
const fsAllow = [desktopDir, resolve(desktopDir, "..")]
try {
  fsAllow.push(realpathSync(resolve(desktopDir, "node_modules")))
} catch {
  // Ignore if node_modules does not exist yet
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: "src/main/index.ts",
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: "src/preload/index.ts",
        output: {
          format: "cjs",
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    server: {
      fs: {
        strict: false,
        allow: fsAllow,
      },
    },
    build: {
      rollupOptions: {
        input: rendererEntry,
      },
    },
  },
})
