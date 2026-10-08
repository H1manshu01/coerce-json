import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/zod.ts", "src/json-schema.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false, // keep the published tarball lean (no .map files)
  treeshake: true,
  splitting: true,
  minify: false,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
