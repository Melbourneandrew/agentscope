import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import { bindLocalSqliteProductionLifecyclePorts } from "../lifecycle/configuration.js";

describe("Local SQLite production lifecycle binding", () => {
  it("binds one exact native snapshot authority and rejects mismatch or rebinding", () => {
    expect(() => {
      bindLocalSqliteProductionLifecyclePorts({} as never, {} as never, 0);
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");

    bindLocalSqliteProductionLifecyclePorts(
      {} as never,
      {} as never,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    expect(() => {
      bindLocalSqliteProductionLifecyclePorts(
        {} as never,
        {} as never,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");
  });
});
