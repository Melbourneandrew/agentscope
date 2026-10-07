import type * as FileSystem from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  path: "",
  wrongLength: false,
  writes: [] as [string, unknown][],
  directories: [] as string[],
  rejects: "",
  markers: [] as string[],
  sinkFailure: false,
  primary: undefined as Error | undefined,
  inventoryFailure: false,
  callbackMode: 0o664,
}));
function expectedSize() {
  if (state.wrongLength) return 8;
  if (state.path.endsWith("source.tar.gz")) return 31_447_709;
  if (state.path.endsWith("maven.zip")) return 9_395_475;
  if (state.path.endsWith("node.tar.gz")) return 54_108_748;
  if (state.path.endsWith("jdk.tar.gz")) return 193_252_603;
  return 9101;
}
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FileSystem>()),
  openSync: (path: string) => {
    state.path = path;
    return 1;
  },
  closeSync: () => {},
  fstatSync: () => ({
    isFile: () => true,
    nlink: 1,
    size: expectedSize(),
    uid: 0,
    gid: 0,
    mode: state.path.endsWith(".java") ? state.callbackMode : 0o600,
  }),
  readSync: (
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const count = Math.min(length, expectedSize() - position);
    buffer.fill(32, offset, offset + count);
    return count;
  },
  mkdirSync: (path: string) => state.directories.push(path),
  writeFileSync: (path: string, bytes: unknown) =>
    state.writes.push([path, bytes]),
  copyFileSync: () => {},
  writeSync: (fd: number, value: string) => {
    expect(fd).toBe(2);
    state.markers.push(value);
    if (state.sinkFailure) throw Error("SINK_CANARY");
    return value.length;
  },
}));
vi.mock("../mockserver-material/source-archive.mjs", () => ({
  verifyMockServerSourceArchive: (value: Buffer) => {
    if (state.rejects === "source") throw state.primary ?? Error("source");
    return value;
  },
}));
vi.mock("../mockserver-material/build-tool-archive.mjs", () => ({
  verifyMavenArchiveBytes: (value: Buffer) => {
    if (state.rejects === "maven") throw Error("maven");
    return value;
  },
}));
vi.mock("../mockserver-material/bootstrap-archive.mjs", () => ({
  verifyBootstrapArchive: (kind: string, value: Buffer) => {
    if (state.rejects === kind) throw Error(kind);
    return value;
  },
}));
vi.mock("../mockserver-material/callback-patch.mjs", () => ({
  patchCallbackSource: () => "synthetic-patched",
}));
vi.mock("../mockserver-material/supplier-inventory.mjs", () => ({
  inventoryMockServerSupplier: () => {
    if (state.inventoryFailure) throw state.primary ?? new Error("inventory");
    return Buffer.from("synthetic-inventory");
  },
}));
import { runMockServerSupplierResearch } from "../mockserver-material/supplier-command.mjs";

// Run the actual command body with synthetic fixed-input I/O. Neither archive
// parsing nor any vendor program runs; fixed byte lengths are mocked below.
beforeEach(() => {
  state.writes = [];
  state.directories = [];
  state.rejects = "";
  state.wrongLength = false;
  state.markers = [];
  state.sinkFailure = false;
  state.primary = undefined;
  state.inventoryFailure = false;
  state.callbackMode = 0o664;
});

describe("fixed last-entered supplier phases without outcome authority", () => {
  const phases = [
    "supplier-entry",
    "supplier-extract",
    "supplier-package",
    "supplier-inventory",
  ];
  it.each([false, true])(
    "preserves ordinary operations with sink failure %s",
    async (failed) => {
      state.sinkFailure = failed;
      const execute = vi.fn(() => Promise.resolve());
      await runMockServerSupplierResearch(execute);
      expect(state.markers).toEqual(
        phases.map(
          (stage) => `[agentscope-material:v1 stage=${stage} family=none]\n`,
        ),
      );
      expect(execute).toHaveBeenCalledTimes(6);
      expect(state.writes.at(-1)?.[0]).toBe("/out/material.json");
    },
  );
  it.each(phases)(
    "marks %s before its actual original operation",
    async (phase) => {
      for (const failed of [false, true]) {
        state.markers = [];
        state.writes = [];
        const primary = new Error("SECRET_CANARY");
        state.primary = primary;
        state.sinkFailure = failed;
        state.rejects = phase === "supplier-entry" ? "source" : "";
        state.inventoryFailure = phase === "supplier-inventory";
        const execute = vi.fn((file: string) => {
          if (
            phase === "supplier-extract" ||
            (phase === "supplier-package" && file.endsWith("/mvn"))
          )
            return Promise.reject(primary);
          return Promise.resolve();
        });
        await expect(runMockServerSupplierResearch(execute)).rejects.toBe(
          state.primary,
        );
        expect(state.markers).toEqual(
          phases
            .slice(0, phases.indexOf(phase) + 1)
            .map(
              (stage) =>
                `[agentscope-material:v1 stage=${stage} family=none]\n`,
            ),
        );
        expect(state.markers.join("")).not.toContain("CANARY");
        expect(
          state.writes.some(([path]) => path === "/out/material.json"),
        ).toBe(false);
        expect(execute).toHaveBeenCalledTimes(
          phase === "supplier-entry" ? 0 : phase === "supplier-extract" ? 1 : 6,
        );
      }
    },
  );
});
afterEach(() => vi.restoreAllMocks());
describe("supplier command extraction/input boundary", () => {
  it.each([0o644, 0o600, 0o674, 0o777])(
    "rejects substituted callback mode %s before patching or packaging",
    async (mode) => {
      state.callbackMode = mode;
      const execute = vi.fn(() => Promise.resolve());
      await expect(runMockServerSupplierResearch(execute)).rejects.toThrow(
        "integration.mockserver-material.supplier-command",
      );
      expect(execute).toHaveBeenCalledTimes(4);
      expect(state.writes).toEqual([]);
      expect(state.markers).toEqual([
        "[agentscope-material:v1 stage=supplier-entry family=none]\n",
        "[agentscope-material:v1 stage=supplier-extract family=none]\n",
      ]);
    },
  );
  it("rejects wrong input lengths before tools, configuration or inventory", async () => {
    state.wrongLength = true;
    const execute = vi.fn();
    await expect(runMockServerSupplierResearch(execute)).rejects.toThrow(
      "supplier-command",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(state.directories).toEqual([]);
  });
  it("executes only the fixed stock extraction and full ordinary supplier recipe", async () => {
    const execute = vi.fn((_file: string, _args: string[], _options: unknown) =>
      Promise.resolve({ stdout: "" }),
    );
    await runMockServerSupplierResearch(execute);
    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/usr/bin/unzip",
      "/usr/bin/tar",
      "/supplier/tools/apache-maven-3.9.16/bin/mvn",
    ]);
    const last = execute.mock.calls.at(-1) as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; maxBuffer: number },
    ];
    expect(last[1]).toContain("-DskipTests");
    expect(last[1]).toContain("package");
    expect(last[1]).not.toContain("--offline");
    expect(last[2].env.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
    expect(last[2].env.NPM_CONFIG_OFFLINE).toBe("false");
    expect(last[2].cwd).toBe("/supplier/source/mockserver");
    expect(last[2].maxBuffer).toBe(8 * 1024 * 1024);
    expect(state.writes.at(-1)).toEqual([
      "/out/material.json",
      Buffer.from("synthetic-inventory"),
    ]);
    expect(
      state.writes.find(([path]) =>
        path.endsWith("CallbackWebSocketServerHandler.java"),
      )?.[1],
    ).toBe("synthetic-patched");
  });
  it.each(["source", "maven", "node", "jdk"])(
    "authenticates %s before stock tools",
    async (kind) => {
      state.rejects = kind;
      const execute = vi.fn();
      await expect(runMockServerSupplierResearch(execute)).rejects.toThrow(
        kind,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("does not emit inventory after an unsettled/failed supplier command", async () => {
    const execute = vi.fn((file: string) =>
      file.endsWith("/mvn")
        ? Promise.reject(Error("synthetic-build-failure"))
        : Promise.resolve(),
    );
    await expect(runMockServerSupplierResearch(execute)).rejects.toThrow(
      "synthetic-build-failure",
    );
    expect(state.writes.some(([path]) => path === "/out/material.json")).toBe(
      false,
    );
  });
});
