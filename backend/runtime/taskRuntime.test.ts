import { describe, expect, it } from "vitest";
import {
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
});
