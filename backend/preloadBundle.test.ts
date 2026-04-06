import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("preload bundle shape", () => {
  beforeAll(() => {
    const preload = join(root, "dist-electron", "preload.cjs");
    if (!existsSync(preload)) {
      execSync("node scripts/build-electron.mjs", { cwd: root, stdio: "pipe" });
    }
  });

  it("preload.cjs is CommonJS and calls exposeInMainWorld for grist", () => {
    const s = readFileSync(join(root, "dist-electron", "preload.cjs"), "utf8");
    expect(s).toMatch(/^"use strict"/m);
    expect(s).toContain("exposeInMainWorld");
    expect(s).toContain("grist");
  });

  it("main.js references preload.cjs", () => {
    const s = readFileSync(join(root, "dist-electron", "main.js"), "utf8");
    expect(s).toContain("preload.cjs");
  });
});
