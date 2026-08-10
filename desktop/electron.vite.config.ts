import { defineConfig } from "electron-vite"
import { fileURLToPath } from "node:url"

const rendererEntry = fileURLToPath(new URL("./src/renderer/index.html", import.meta.url))

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
    build: {
      rollupOptions: {
        input: rendererEntry,
      },
    },
  },
})
