import { defineConfig } from "tsup";

// Both commands run locally. The dashboard renders each page on the server.
export default defineConfig({
  entry: ["src/main.ts", "src/answer-main.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
});
