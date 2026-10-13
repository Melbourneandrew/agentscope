import {
  state,
  workerSource,
  privateWorker,
  supplierMarker,
} from "./__tests__/fixtures/mockserver-supplier-command.js";
import { describe, expect, it, vi } from "vitest";
describe("initial cache diagnostic preservation", () => {
  it("preserves initial read order and primary I/O failure with a throwing optional sink", async () => {
    state.cacheIssue = "mode";
    await expect(
      privateWorker(async () => {}, "service-offline"),
    ).rejects.toThrow("supplier-command");
    expect(state.cacheReads).toEqual([
      "named:/supplier",
      "named:/supplier/maven-repository",
      "open:/supplier/maven-repository",
      "held",
      "held",
      "named:/supplier/maven-repository",
      "named:/supplier",
      "close",
    ]);
    state.cacheIssue = "io";
    state.sinkFailure = true;
    state.primary = new Error("PRIVATE_IO_CANARY");
    await expect(privateWorker(async () => {}, "service-offline")).rejects.toBe(
      state.primary,
    );
    expect(state.markers.at(-1)).toBe(
      supplierMarker("supplier-cache-maven-io"),
    );
    expect(state.markers.join("")).not.toContain("CANARY");
    expect(state.closed).toBe(state.opened);
  });
});
describe("physical cache adoption refusal", () => {
  it.each([
    "missing",
    "file",
    "symlink",
    "device",
    "identity",
    "owner",
    "group",
    "mode",
    "parent",
    "io",
  ])(
    "rejects %s cache before extraction and closes any held descriptors",
    async (issue) => {
      state.cacheIssue = issue;
      const execute = vi.fn(() => Promise.resolve());
      await expect(privateWorker(execute, "offline-build")).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(state.writes).toEqual([]);
      expect(state.closed).toBe(state.opened);
      const reason =
        (
          {
            missing: "io",
            file: "type",
            symlink: "type",
            group: "owner",
          } as Record<string, string>
        )[issue] ?? issue;
      expect(state.markers.at(-1)).toBe(
        supplierMarker(
          `supplier-cache-${issue === "missing" ? "npm" : "maven"}-${reason}`,
        ),
      );
      expect(state.markers.join("")).not.toContain("CANARY");
    },
  );
  it("rejects changed physical cache metadata after package without freezing its content timestamps", async () => {
    const execute = vi.fn((file) => {
      if (String(file).endsWith("/mvn")) state.cacheIssue = "mode";
      return Promise.resolve();
    });
    await expect(privateWorker(execute, "offline-build")).rejects.toThrow(
      "supplier-command",
    );
    expect(state.writes.some(([path]) => path === "/out/material.json")).toBe(
      false,
    );
    expect(state.closed).toBe(state.opened);
    expect(state.markers.at(-1)).toBe(
      supplierMarker("supplier-service-finalization"),
    );
  });
  it("rejects an unknown mode before any filesystem operation", async () => {
    const execute = vi.fn(() => Promise.resolve());
    await expect(privateWorker(execute, "other")).rejects.toThrow(
      "build-recipe",
    );
    expect(state.opened).toBe(0);
    expect(state.directories).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(workerSource).toMatch(
      /await runSupplier\(\s*execute,\s*process\.argv\[2\],\s*process\.argv\[2\] === "offline-build" \|\|\s*process\.argv\[2\] === "service-offline",?\s*\)/u,
    );
    expect(workerSource).toMatch(
      /"dependency-research",\s*"offline-build",\s*"cache-seeding",\s*"service-offline",/u,
    );
  });
  it.each(["source", "maven", "node", "jdk"])(
    "reauthenticates %s in offline mode",
    async (kind) => {
      state.rejects = kind;
      const execute = vi.fn(() => Promise.resolve());
      await expect(privateWorker(execute, "offline-build")).rejects.toThrow(
        kind,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(state.closed).toBe(state.opened);
    },
  );
  it("preserves offline package failure identity even when the optional sink throws", async () => {
    state.sinkFailure = true;
    const primary = new Error("synthetic-offline-primary");
    const execute = vi.fn((file) =>
      String(file).endsWith("/mvn")
        ? Promise.reject(primary)
        : Promise.resolve(),
    );
    await expect(privateWorker(execute, "offline-build")).rejects.toBe(primary);
    expect(state.writes.some(([path]) => path === "/out/material.json")).toBe(
      false,
    );
    expect(state.closed).toBe(state.opened);
  });
});
