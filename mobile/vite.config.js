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
    alias: [
      {
        find: /^.*[/\\]runtime[/\\]dist[/\\]protocol[/\\]([^/\\]+)\.js$/,
        replacement: `${fileURLToPath(new URL("../runtime/src/protocol", import.meta.url)).replace(/\\/g, "/")}/$1.ts`,
      },
      { find: "@surface", replacement: fileURLToPath(new URL("../frontend-web/src", import.meta.url)) },
      { find: "lucide-react", replacement: fileURLToPath(new URL("./node_modules/lucide-react", import.meta.url)) },
    ],
  },
  server: { port: 5174, fs: { allow: [".."] }, watch: { ignored: ["**/android/**", "**/ios/**", "**/.qa/**"] } },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{js,jsx}"] },
});
