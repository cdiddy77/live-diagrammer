import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel root is this directory; the package root is one level up.
// `base: "./"` makes one build serve from the dev server, a plain http server,
// and the Chrome side panel at chrome-extension://<id>/panel/index.html.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  server: { fs: { allow: [".."] }, port: 5174, strictPort: true },
});
