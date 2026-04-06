import { describe, it, expect } from "vitest";
import { extractJsonObject } from "./jsonExtract.js";

describe("extractJsonObject", () => {
  it("parses object embedded in prose", () => {
    const text = 'Here you go:\n```\n{"a":1,"b":"ok"}\n```\ntrailing';
    const j = extractJsonObject(text) as { a: number; b: string };
    expect(j.a).toBe(1);
    expect(j.b).toBe("ok");
  });

  it("throws when no braces", () => {
    expect(() => extractJsonObject("no json")).toThrow(/No JSON object/);
  });
});
