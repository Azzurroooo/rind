import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), {
    name: "local-dev-csp", apply: "serve",
    // Vite's React refresh preamble is inline; the packaged build retains its CSP.
    transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
  }],
  publicDir: "../frontend-web/public",
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@surface": fileURLToPath(new URL("../frontend-web/src", import.meta.url)),
      "lucide-react": fileURLToPath(new URL("./node_modules/lucide-react", import.meta.url)),
    },
  },
  server: { port: 5174, fs: { allow: [".."] }, watch: { ignored: ["**/android/**", "**/ios/**", "**/.qa/**"] } },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{js,jsx}"] },
});
