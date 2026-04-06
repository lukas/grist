import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertUnderRoot } from "./pathGuard.js";

describe("assertUnderRoot", () => {
  it("resolves a normal relative path inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "grist-pg-"));
    const inner = join(root, "src", "a.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(inner, "x");
    const got = assertUnderRoot(root, "src/a.ts");
    expect(got).toBe(inner);
  });

  it("rejects path traversal leaving root", () => {
    const root = mkdtempSync(join(tmpdir(), "grist-pg-"));
    expect(() => assertUnderRoot(root, "../outside")).toThrow(/Path escapes/);
  });
});
