import { defineConfig } from "tsup";

// One entry, because the dashboard is one local process. It renders every page
// on the server, so the build produces no browser bundle.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
});
