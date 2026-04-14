import { describe, expect, it } from "vitest";
import {
  __taskRuntimeInternals,
  buildRuntimeWrappedCommand,
  parseTaskRuntime,
  stringifyTaskRuntime,
} from "./taskRuntime.js";

describe("taskRuntime", () => {
  it("round-trips runtime json", () => {
    const runtime = parseTaskRuntime(stringifyTaskRuntime({
      mode: "docker",
      status: "running",
      strategy: "node_dev",
      supportsExec: true,
      containerName: "grist-1-2",
      hostPorts: { http: 47001 },
      serviceUrls: ["http://127.0.0.1:47001"],
      workdir: "/workspace",
    }));

    expect(runtime.mode).toBe("docker");
    expect(runtime.hostPorts.http).toBe(47001);
  });

  it("wraps commands for docker exec when exec is supported", () => {
    const wrapped = buildRuntimeWrappedCommand(
      {
        mode: "docker",
        status: "running",
        strategy: "node_dev",
        supportsExec: true,
        containerName: "grist-1-2",
        hostPorts: { http: 47001 },
        serviceUrls: ["http://127.0.0.1:47001"],
        workdir: "/workspace",
      },
      "npm test",
      "/tmp/repo/src",
      "/tmp/repo",
    );

    expect(wrapped.command).toContain("docker exec");
    expect(wrapped.command).toContain("npm test");
  });

  it("does not treat CLI node scripts as server runtimes", () => {
    expect(__taskRuntimeInternals.isLikelyServerScript("node dist/index.js")).toBe(false);
    expect(__taskRuntimeInternals.isLikelyServerScript("tsc && node dist/index.js")).toBe(false);
  });

  it("still recognizes common web dev servers", () => {
    expect(__taskRuntimeInternals.isLikelyServerScript("vite")).toBe(true);
    expect(__taskRuntimeInternals.isLikelyServerScript("next dev")).toBe(true);
    expect(__taskRuntimeInternals.isLikelyServerScript("HOST=0.0.0.0 PORT=3000 node server.js")).toBe(true);
  });
});
