import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: ["electron", "better-sqlite3"],
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, "electron/main.ts")],
  outfile: join(root, "dist-electron/main.js"),
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "electron/preload.ts")],
  outfile: join(root, "dist-electron/preload.js"),
});

copyFileSync(join(root, "backend/db/schema.sql"), join(root, "dist-electron/schema.sql"));

console.log("electron bundle ok");
