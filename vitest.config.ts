import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["backend/**/*.test.ts", "frontend/**/*.test.tsx"],
    environmentMatchGlobs: [
      ["frontend/**", "jsdom"],
    ],
  },
  resolve: {
    alias: {
      "@backend": resolve(__dirname, "backend"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
});
