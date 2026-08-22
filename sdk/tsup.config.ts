import { defineConfig } from "tsup";

export default defineConfig({
  // The replay endpoint is a separate entry, so a program that imports the
  // client library cannot reach it. It answers from a recording, and a
  // caller must ask for it by name.
  entry: { index: "src/index.ts", cli: "src/cli.ts", replay: "replay/endpoint.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
});
