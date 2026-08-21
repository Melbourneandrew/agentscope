import { describe, expect, it } from "vitest";

import * as root from "./index.js";
import * as reporter from "./reporter/index.js";
import * as retriever from "./retriever/index.js";

describe("Local SQLite package boundaries", () => {
  it("exports only the production identity and native admission surface", () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
        "inspectLocalSqliteNativeSupport",
        "localSqliteDestinationPackageId",
        "localSqliteReporterPackageId",
        "localSqliteRetrieverPackageId",
      ].sort(),
    );
    expect(reporter.localSqliteReporterPackageId).toBe(
      "@agentscope/destination-local-sqlite/reporter",
    );
    expect(retriever.localSqliteRetrieverPackageId).toBe(
      "@agentscope/destination-local-sqlite/retriever",
    );
    expect(
      root.inspectLocalSqliteNativeSupport({
        nodeAbi: 127,
        nodeMajor: 22,
        platform: "darwin",
        osVersion: "15.0",
        architecture: "arm64",
        libcFamily: null,
        libcVersion: null,
        credentialBackend: "keychain",
        filesystemProfile: "local-apfs",
      }),
    ).toEqual({
      state: "unavailable",
      code: "destination.local-sqlite.native-unavailable",
    });
    const hostileRuntime = new Proxy(
      {} as Parameters<typeof root.inspectLocalSqliteNativeSupport>[0],
      {
        getPrototypeOf: () => {
          throw new Error("CANARY");
        },
      },
    );
    expect(root.inspectLocalSqliteNativeSupport(hostileRuntime).state).toBe(
      "unavailable",
    );
  });
});
