import {
  state,
  privateWorker,
  runMockServerSupplierResearch,
  classifyPackageFailure,
  supplierMarker,
  phases,
} from "./__tests__/fixtures/mockserver-supplier-command.js";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
describe("actual package rejection has only bounded fixed observations", () => {
  it.each([
    ["compilation", "[ERROR] COMPILATION ERROR :"],
    [
      "resolution",
      "[ERROR] Failed to execute goal on project mockserver-core: Could not resolve dependencies",
    ],
    [
      "frontend",
      "[ERROR] Failed to execute goal com.github.eirslett:frontend-maven-plugin:1.15.1:npm (npm build) on project mockserver-netty:",
    ],
    ["other", "PRIVATE_CANARY"],
    ["other", "prefix [ERROR] COMPILATION ERROR :"],
    [
      "other",
      "[ERROR] COMPILATION ERROR :\n[ERROR] Failed to execute goal com.github.eirslett:frontend-maven-plugin:1.15.1:npm ",
    ],
    ["other", "accessor"],
    ["other", "proxy"],
    ["other", "oversized"],
  ])("preserves primary identity for %s/%s", async (category, output) => {
    let reads = 0;
    const native = Object.assign(new Error("PRIVATE_CANARY"), {
      stdout: "",
      stderr: output === "oversized" ? "X".repeat(8 * 1024 * 1024 + 1) : output,
    });
    if (output === "accessor")
      Object.defineProperty(native, "stdout", {
        get() {
          reads++;
          throw Error("PRIVATE_CANARY");
        },
      });
    const primary =
      output === "proxy"
        ? new Proxy(native, {
            getOwnPropertyDescriptor() {
              reads++;
              throw Error("PRIVATE_CANARY");
            },
          })
        : native;
    const run = vi.fn((file: string) =>
      file.endsWith("/mvn") ? Promise.reject(primary) : Promise.resolve(),
    );
    const detail = classifyPackageFailure(primary).join(",");
    for (const connected of [false, true]) {
      await expect(
        connected
          ? privateWorker(run, "cache-seeding", false)
          : runMockServerSupplierResearch(run),
      ).rejects.toBe(primary);
      expect(state.markers.at(-1)).toBe(
        supplierMarker(`supplier-package-${category}`, connected, detail),
      );
    }
    expect(reads).toBe(0);
    expect(state.markers.join("")).not.toContain("CANARY");
    expect(state.closed).toBe(state.opened);
    state.sinkFailure = true;
    await expect(runMockServerSupplierResearch(run)).rejects.toBe(primary);
  });
});
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
        untrustedBootstrapStage:
          phase === "supplier-package"
            ? "supplier-package-other"
            : phase === "supplier-entry"
              ? "supplier-cache-npm"
              : phase,
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
  it.each(["cache-seeding", "service-offline"])(
    "builds actual %s inputs without adopting research inventory",
    async (phase) => {
      const calls: {
        file: string;
        args: string[];
        options: { env: Record<string, string>; cwd: string };
      }[] = [];
      await privateWorker((file, args, options) => {
        calls.push({
          file,
          args: args as string[],
          options: options as (typeof calls)[number]["options"],
        });
        return Promise.resolve();
      }, phase);
      expect(calls).toHaveLength(6);
      expect(calls[0]?.args).toContain("/supplier/inputs/source.tar.gz");
      expect(calls[0]?.args).toContain("/supplier/source");
      expect(calls.at(-1)?.args.includes("--offline")).toBe(
        phase === "service-offline",
      );
      expect(calls.at(-1)?.options.env.NPM_CONFIG_OFFLINE).toBe(
        phase === "service-offline" ? "true" : "false",
      );
      expect(calls.at(-1)?.options.cwd).toBe("/supplier/source/mockserver");
      expect(
        state.writes
          .filter(([path]) => path.endsWith(".java"))
          .map(([path]) => path.split("/").at(-1)),
      ).toEqual([
        "CallbackWebSocketServerHandler.java",
        "JsonBodySerializer.java",
        "MockServerEventLog.java",
        "HttpState.java",
        "RecordedRequestsFileSystemPersistence.java",
        "LifeCycle.java",
        "HttpRequestHandler.java",
      ]);
      expect(state.writes.some(([path]) => path.startsWith("/out/"))).toBe(
        false,
      );
      expect(state.closed).toBe(state.opened);
    },
  );
  it.each([
    "directory",
    "symlink",
    "links",
    "empty",
    "oversized",
    "owner",
    "mode",
    "identity",
    "changed",
  ])(
    "rejects %s final JAR without research output or leaked descriptors",
    async (issue) => {
      state.artifactIssue = issue;
      for (const phase of ["cache-seeding", "service-offline"])
        await expect(privateWorker(async () => {}, phase)).rejects.toThrow(
          "supplier-command",
        );
      expect(state.writes.some(([path]) => path.startsWith("/out/"))).toBe(
        false,
      );
      expect(state.closed).toBe(state.opened);
    },
  );
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
            .concat(
              phase === "supplier-package" ? ["supplier-package-other"] : [],
            )
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
  it.each([
    ...["read", "guard", "internal"].map((kind) => `inventory-${kind}`),
    "output-create",
    "output-write",
  ])(
    "preserves exact %s failure across phase and throwing diagnostic sinks",
    async (category) => {
      for (const connected of [false, true])
        for (const sinkFailure of [false, true]) {
          state.markers = [];
          state.failureCategory = category;
          state.primary = new Error("SECRET_CANARY");
          state.sinkFailure = sinkFailure;
          await expect(
            privateWorker(
              async () => {},
              connected ? "dependency-research" : "offline-build",
              !connected,
            ),
          ).rejects.toBe(state.primary);
          expect(state.markers.at(-1)).toBe(
            supplierMarker(`supplier-${category}`, connected),
          );
          expect(state.markers.join("")).not.toContain("CANARY");
        }
    },
  );
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
      expect(state.markers).toEqual(
        phases.slice(0, 2).map((stage) => supplierMarker(stage)),
      );
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
