import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    "scrum/index": "src/scrum/index.ts",
    "kanban/index": "src/kanban/index.ts",
    "waterfall/index": "src/waterfall/index.ts",
    "schema/index": "src/schema/index.ts",
    "adapters/index": "src/adapters/index.ts",
    "cli/index": "src/cli/index.ts",
    "cli/bin": "src/cli/bin.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: "node18",
  platform: "node",
  external: ["ex-flow", "exsorted"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
});
