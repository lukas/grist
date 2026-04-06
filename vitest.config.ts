import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["backend/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@backend": resolve(__dirname, "backend"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
});
