import { describe, expect, it, vi } from "vitest";

describe("Local SQLite production lifecycle binding", () => {
  it("binds one exact native snapshot authority and rejects mismatch or rebinding", async () => {
    vi.resetModules();
    const mismatch = await import("../lifecycle/configuration.js");
    expect(() => {
      mismatch.bindLocalSqliteProductionLifecyclePorts(
        {} as never,
        {} as never,
        0,
      );
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");

    vi.resetModules();
    const exact = await import("../lifecycle/configuration.js");
    const capability = await import("../lifecycle/capability.js");
    exact.bindLocalSqliteProductionLifecyclePorts(
      {} as never,
      {} as never,
      capability.LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    expect(() => {
      exact.bindLocalSqliteProductionLifecyclePorts(
        {} as never,
        {} as never,
        capability.LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");
  });
});
