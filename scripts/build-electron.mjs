import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, cpSync, unlinkSync, mkdirSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  /** dotenv is CJS with `require("fs")`; bundling it into ESM breaks under Electron ("Dynamic require of fs"). */
  external: ["electron", "better-sqlite3", "dotenv"],
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, "electron/main.ts")],
  outfile: join(root, "dist-electron/main.js"),
});

/** Preload must be CJS: ESM preload + package "type":"module" often breaks in Electron (no window.grist). */
await esbuild.build({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  entryPoints: [join(root, "electron/preload.ts")],
  outfile: join(root, "dist-electron/preload.cjs"),
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "cli/grist-cli.ts")],
  outfile: join(root, "dist-electron/grist-cli.js"),
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "cli/skills-cli.ts")],
  outfile: join(root, "dist-electron/skills-cli.js"),
});

copyFileSync(join(root, "backend/db/schema.sql"), join(root, "dist-electron/schema.sql"));

const assetsOut = join(root, "dist-electron/../assets");
if (!existsSync(assetsOut)) mkdirSync(assetsOut, { recursive: true });
const iconSrc = join(root, "assets/icon.png");
if (existsSync(iconSrc)) copyFileSync(iconSrc, join(assetsOut, "icon.png"));
const icnsSrc = join(root, "assets/icon.icns");
if (existsSync(icnsSrc)) copyFileSync(icnsSrc, join(assetsOut, "icon.icns"));

const bundledSkillsSrc = join(root, "bundled-skills");
const bundledSkillsOut = join(root, "dist-electron", "bundled-skills");
if (existsSync(bundledSkillsSrc)) {
  cpSync(bundledSkillsSrc, bundledSkillsOut, { recursive: true });
}

for (const stale of ["preload.js", "preload.js.map"]) {
  try {
    unlinkSync(join(root, "dist-electron", stale));
  } catch {
    /* ignore */
  }
}

console.log("electron bundle ok");
