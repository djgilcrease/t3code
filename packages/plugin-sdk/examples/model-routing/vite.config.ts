import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["plugin.mjs"],
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node22",
    clean: true,
    deps: { alwaysBundle: () => true, onlyBundle: false },
  },
});
