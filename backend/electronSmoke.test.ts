import { describe, it } from "vitest";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (grist/), from backend/electronSmoke.test.ts */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** macOS session usually has GUI; Linux CI needs DISPLAY or force with RUN_ELECTRON_SMOKE=1 */
const canRunElectronGui =
  process.env.RUN_ELECTRON_SMOKE === "1" ||
  process.platform === "darwin" ||
  Boolean(process.env.DISPLAY);

describe.skipIf(!canRunElectronGui)("electron preload (real Binary)", () => {
  it(
    "exposes window.grist on about:blank",
    { timeout: 120_000 },
    () => {
      execSync("npm run test:electron-smoke", {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "0" },
        shell: true,
      });
    }
  );
});
