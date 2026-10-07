import type * as FileSystem from "node:fs";
import * as fs from "node:fs";
import { runInNewContext } from "node:vm";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";
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
  cacheIssue: "",
  opened: 0,
  closed: 0,
  timestamp: 0,
}));
function statusFor(path: string, held = false) {
  const cache = path.endsWith("maven-repository") || path.endsWith("npm-cache");
  const directory = cache || path === "/supplier";
  return {
    isFile: () => !directory || (cache && state.cacheIssue === "file"),
    isDirectory: () => directory && !(cache && state.cacheIssue === "file"),
    isSymbolicLink: () => cache && state.cacheIssue === "symlink",
    dev: cache && state.cacheIssue === "device" ? 2 : 1,
    ino:
      path.length + (cache && held && state.cacheIssue === "identity" ? 1 : 0),
    nlink: 1,
    size: directory ? 0 : expectedSize(),
    uid: cache && state.cacheIssue === "owner" ? 1 : 0,
    gid: cache && state.cacheIssue === "group" ? 1 : 0,
    mode: directory
      ? cache && state.cacheIssue === "mode"
        ? 0o755
        : 0o700
      : path.endsWith(".java")
        ? state.callbackMode
        : 0o600,
    mtimeMs: directory ? state.timestamp++ : 0,
    ctimeMs: directory ? state.timestamp++ : 0,
  };
}
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
    state.opened++;
    return 1;
  },
  closeSync: () => state.closed++,
  fstatSync: () => statusFor(state.path, true),
  lstatSync: (path: string) => {
    if (state.cacheIssue === "missing" && path.endsWith("npm-cache"))
      throw Error("synthetic-missing-cache");
    return statusFor(path);
  },
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
import { verifyMockServerSourceArchive } from "../mockserver-material/source-archive.mjs";
import { verifyMavenArchiveBytes } from "../mockserver-material/build-tool-archive.mjs";
import { verifyBootstrapArchive } from "../mockserver-material/bootstrap-archive.mjs";
import { patchCallbackSource } from "../mockserver-material/callback-patch.mjs";
import { inventoryMockServerSupplier } from "../mockserver-material/supplier-inventory.mjs";
import {
  mockServerSupplierBuildPlan,
  mockServerSupplierLayout,
  supplierGlobalMavenSettings,
  supplierMavenSettings,
} from "../mockserver-material/build-recipe.mjs";

const workerSource = fs.readFileSync(
  new URL("../mockserver-material/supplier-command.mjs", import.meta.url),
  "utf8",
);
const privateWorker = runInNewContext(
  `${workerSource.slice(workerSource.indexOf("const environment ="), workerSource.indexOf("export const runMockServerSupplierResearch"))}\nrunSupplier`,
  {
    ...fs,
    Buffer,
    maximumOutputBytes: 8 * 1024 * 1024,
    verifyMockServerSourceArchive,
    verifyMavenArchiveBytes,
    verifyBootstrapArchive,
    patchCallbackSource,
    inventoryMockServerSupplier,
    mockServerSupplierBuildPlan,
    mockServerSupplierLayout,
    supplierGlobalMavenSettings,
    supplierMavenSettings,
  },
) as (
  run: (file: string, ...args: unknown[]) => Promise<unknown>,
  phase: string,
  observe?: boolean,
) => Promise<void>;

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
  state.cacheIssue = "";
  state.opened = state.closed = 0;
  state.timestamp = 0;
});

const phases = Object.freeze([
  "supplier-entry",
  "supplier-extract",
  "supplier-package",
  "supplier-inventory",
]);
const supplierMarker = (stage: string, connected = false) =>
  `[agentscope-material:v1 stage=${connected ? stage.replace("supplier-", "supplier-connected-") : stage} family=none]\n`;
describe("composite build has monotonic connected and offline diagnostics", () => {
  it.each(phases)(
    "retains %s from the actual collector after the connected build",
    async (phase) => {
      const observation = createBuildStderrObservation();
      await privateWorker(
        vi.fn(() => Promise.resolve()),
        "dependency-research",
        false,
      );
      expect(state.markers).toEqual(
        phases.map((stage) => supplierMarker(stage, true)),
      );
      const primary = new Error("PRIVATE_CANARY");
      state.primary = primary;
      state.rejects = phase === "supplier-entry" ? "source" : "";
      state.inventoryFailure = phase === "supplier-inventory";
      const execute = vi.fn((file) =>
        phase === "supplier-extract" ||
        (phase === "supplier-package" && String(file).endsWith("/mvn"))
          ? Promise.reject(primary)
          : Promise.resolve(),
      );
      await expect(privateWorker(execute, "offline-build", true)).rejects.toBe(
        primary,
      );
      for (const [index, marker] of state.markers.entries())
        observation.consume(Buffer.from(`#20 ${index}.100 ${marker}`));
      expect(observation.snapshot()).toMatchObject({
        untrustedBootstrapStage: phase,
        untrustedBootstrapFailureFamily: "none",
      });
      expect(state.markers.join("")).not.toContain("CANARY");
      const prior = createBuildStderrObservation();
      for (const [index, stage] of phases.entries())
        prior.consume(Buffer.from(`#10 ${index}.100 ${supplierMarker(stage)}`));
      prior.consume(
        Buffer.from(
          "#20 4.100 [agentscope-material:v1 stage=supplier-entry family=none]\n",
        ),
      );
      expect(prior.snapshot().untrustedBootstrapStage).toBeUndefined();
    },
  );
  it("retains a connected-stage failure without an offline or cause claim", async () => {
    state.rejects = "source";
    const observation = createBuildStderrObservation();
    await expect(
      privateWorker(vi.fn(), "dependency-research", false),
    ).rejects.toThrow("source");
    for (const marker of state.markers)
      observation.consume(Buffer.from(marker));
    expect(observation.snapshot()).toEqual({
      stderrClass: "unknown",
      untrustedBootstrapStage: "supplier-connected-entry",
      untrustedBootstrapFailureFamily: "none",
    });
  });
});

describe("fresh offline worker adopts only conventional cache roots", () => {
  it("reextracts and patches originals before the full offline package goal", async () => {
    const execute = vi.fn(() => Promise.resolve());
    await privateWorker(execute, "offline-build");
    expect(state.directories).not.toContain("/supplier/maven-repository");
    expect(state.directories).not.toContain("/supplier/npm-cache");
    expect(state.directories).toContain("/supplier/source");
    expect(state.directories).toContain("/supplier/tools");
    expect(execute.mock.calls).toHaveLength(6);
    const calls = execute.mock.calls as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ][];
    expect(calls.slice(0, 5).map(([file]) => file)).toEqual([
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/usr/bin/tar",
      "/usr/bin/unzip",
      "/usr/bin/tar",
    ]);
    expect(calls[0]![1]).toContain("/supplier/inputs/source.tar.gz");
    expect(calls[0]![1]).toContain("/supplier/source");
    const last = calls.at(-1)!;
    expect(last[1][0]).toBe("--offline");
    expect(last[1]).toContain("package");
    expect(last[2].env.NPM_CONFIG_OFFLINE).toBe("true");
    expect(last[2].cwd).toBe("/supplier/source/mockserver");
    expect(state.writes.find(([path]) => path.endsWith(".java"))?.[1]).toBe(
      "synthetic-patched",
    );
    expect(state.writes.at(-1)?.[0]).toBe("/out/material.json");
    expect(state.closed).toBe(state.opened);
    expect(state.timestamp).toBeGreaterThan(0);
  });
  it.each([
    "missing",
    "file",
    "symlink",
    "device",
    "identity",
    "owner",
    "group",
    "mode",
  ])(
    "rejects %s cache before extraction and closes any held descriptors",
    async (issue) => {
      state.cacheIssue = issue;
      const execute = vi.fn(() => Promise.resolve());
      await expect(privateWorker(execute, "offline-build")).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(state.writes).toEqual([]);
      expect(state.closed).toBe(state.opened);
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
      /await runSupplier\(\s*execute,\s*process\.argv\[2\],\s*process\.argv\[2\] === "offline-build",?\s*\)/u,
    );
    expect(workerSource).toContain(
      '["dependency-research", "offline-build"].includes(process.argv[2])',
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

describe("fixed last-entered supplier phases without outcome authority", () => {
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
  it.each(
    phases.flatMap((phase) =>
      [false, true].map((connected) => ({ phase, connected })),
    ),
  )(
    "marks $phase before its actual original operation (connected=$connected)",
    async ({ phase, connected }) => {
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
        await expect(
          connected
            ? privateWorker(execute, "dependency-research", false)
            : runMockServerSupplierResearch(execute),
        ).rejects.toBe(state.primary);
        expect(state.markers).toEqual(
          phases
            .slice(0, phases.indexOf(phase) + 1)
            .map((stage) => supplierMarker(stage, connected)),
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
