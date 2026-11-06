import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/core/types.ts",
    "scrum/index": "src/methodologies/scrum/index.ts",
    "kanban/index": "src/methodologies/kanban/index.ts",
    "waterfall/index": "src/methodologies/waterfall/index.ts",
    "investigation/index": "src/methodologies/investigation/index.ts",
    "experimentation/index": "src/methodologies/experimentation/index.ts",
    "schema/index": "src/schema/index.ts",
    "registry/index": "src/registry.ts",
    "policies/index": "src/policies/index.ts",
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
