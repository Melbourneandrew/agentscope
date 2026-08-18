import { describe, expect, it, vi } from "vitest";

import {
  compileHarnessRegistry,
  defineHarnessDescriptor,
} from "./descriptor.js";
import { discoverHarness, HarnessDiscoveryError } from "./discovery.js";
import type {
  HarnessDescriptorInput,
  HarnessDiscoveryProbe,
  HarnessExecutableProbeResult,
  HarnessVersionProbeResult,
} from "./types.js";

const digest = `sha256-${"b".repeat(64)}`;
const descriptorInput: HarnessDescriptorInput = {
  descriptorVersion: 1,
  harnessType: "@agentscope/harness-codex",
  executable: {
    names: ["codex", "codex-cli"],
    versionArguments: ["--version"],
    versionPrefix: "codex ",
    versionSuffix: " release",
  },
  configuration: {
    locationSegments: [
      ["codex", "config.toml"],
      ["codex", "settings.json"],
    ],
  },
  compatibility: [
    {
      minimumInclusive: "1.0.0",
      maximumExclusive: "2.0.0",
      evidenceSlot: "stable-v1",
    },
  ],
  nativeSource: { sourceKind: "codex-session", continuityVersion: 1 },
};
const descriptor = defineHarnessDescriptor(descriptorInput);
const registry = compileHarnessRegistry([descriptor], {
  manifestVersion: 1,
  entries: [
    {
      harnessType: descriptor.harnessType,
      evidenceSlot: "stable-v1",
      testedVersion: "1.4.0",
      contractSuiteDigest: digest,
      realScenarioDigest: digest,
    },
  ],
});

const probe = (
  executable: HarnessExecutableProbeResult = {
    kind: "found",
    candidates: [{ path: "/usr/local/bin/codex" }],
  },
  version: HarnessVersionProbeResult = {
    kind: "observed",
    output: "codex 1.4.0 release\n",
  },
): HarnessDiscoveryProbe => ({
  locateExecutable: vi.fn().mockResolvedValue(executable),
  readVersion: vi.fn().mockResolvedValue(version),
  inspectConfiguration: vi.fn().mockResolvedValue([
    { locationIndex: 1, present: false },
    { locationIndex: 0, present: true },
  ]),
});

describe("harness discovery", () => {
  it("classifies a compatible installation using read-only probes", async () => {
    const operations = probe();
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered).toEqual({
      harnessType: descriptor.harnessType,
      state: "installed",
      reason: "compatible",
      version: "1.4.0",
      configurationLocations: [
        { locationIndex: 0, present: true },
        { locationIndex: 1, present: false },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock without invoking it.
    expect(vi.mocked(operations.locateExecutable)).toHaveBeenCalledWith([
      "codex",
      "codex-cli",
    ]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock without invoking it.
    expect(vi.mocked(operations.readVersion)).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["--version"],
    );
    expect(Object.isFrozen(discovered)).toBe(true);
    expect(Object.isFrozen(discovered.configurationLocations)).toBe(true);
  });

  it.each([
    [{ kind: "absent" } as const, undefined, "absent", "not-found"],
    [
      { kind: "unavailable" } as const,
      undefined,
      "indeterminate",
      "probe-unavailable",
    ],
    [
      {
        kind: "found" as const,
        candidates: [{ path: "/bin/codex" }, { path: "/opt/bin/codex" }],
      },
      undefined,
      "indeterminate",
      "ambiguous-executable",
    ],
    [
      undefined,
      { kind: "unavailable" } as const,
      "indeterminate",
      "version-unavailable",
    ],
    [
      undefined,
      { kind: "observed", output: "codex 01.4.0 release" } as const,
      "indeterminate",
      "version-invalid",
    ],
    [
      undefined,
      { kind: "observed", output: "codex 2.0.0 release" } as const,
      "unsupported",
      "version-unsupported",
    ],
  ])(
    "classifies discovery state without mutation",
    async (executable, version, state, reason) => {
      const discovered = await discoverHarness(
        registry,
        descriptor.harnessType,
        probe(executable ?? undefined, version ?? undefined),
      );
      expect(discovered).toMatchObject({ state, reason });
    },
  );
});

describe("harness discovery hostile boundaries", () => {
  it("collapses malformed and throwing probe output to fixed indeterminate evidence", async () => {
    const operations = probe();
    operations.locateExecutable = vi
      .fn()
      .mockRejectedValue(new Error("CANARY_SECRET"));
    operations.inspectConfiguration = vi
      .fn()
      .mockRejectedValue(new Error("CANARY_PATH"));
    await expect(
      discoverHarness(registry, descriptor.harnessType, operations),
    ).resolves.toEqual({
      harnessType: descriptor.harnessType,
      state: "indeterminate",
      reason: "probe-unavailable",
      version: null,
      configurationLocations: [],
    });

    const accessor = { kind: "found", candidates: [] };
    let reads = 0;
    Object.defineProperty(accessor, "candidates", {
      get() {
        reads += 1;
        return [{ path: "/bin/codex" }];
      },
      enumerable: true,
    });
    const hostile = probe();
    hostile.locateExecutable = vi.fn().mockResolvedValue(accessor);
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      hostile,
    );
    expect(discovered.reason).toBe("probe-unavailable");
    expect(reads).toBe(0);
  });

  it.each([
    null,
    [],
    { kind: "found", candidates: [] },
    { kind: "found", candidates: [{ path: "relative/codex" }] },
    { kind: "found", candidates: [{ path: "" }] },
    { kind: "found", candidates: [{ path: 42 }] },
    { kind: "found", candidates: [{ path: `/${"x".repeat(4_097)}` }] },
    { kind: "found", candidates: [{ path: "/bin/codex", extra: true }] },
    {
      kind: "found",
      candidates: Array.from({ length: 17 }, (_, index) => ({
        path: `/bin/codex-${index}`,
      })),
    },
  ])("rejects malformed executable probe DTOs", async (candidate) => {
    const operations = probe();
    operations.locateExecutable = vi.fn().mockResolvedValue(candidate);
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered.reason).toBe("probe-unavailable");
  });

  it.each([
    null,
    { kind: "observed" },
    { kind: "observed", output: 42 },
    { kind: "observed", output: "x".repeat(4_097) },
    { kind: "observed", output: "wrong 1.4.0 release" },
    { kind: "observed", output: "codex 1.4.0 wrong" },
  ])("rejects malformed version probe DTOs", async (candidate) => {
    const operations = probe();
    operations.readVersion = vi.fn().mockResolvedValue(candidate);
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered.state).toBe("indeterminate");
  });

  it("contains version probe rejection", async () => {
    const operations = probe();
    operations.readVersion = vi.fn().mockRejectedValue(new Error("CANARY"));
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered.reason).toBe("version-unavailable");
  });

  it.each([
    null,
    [],
    [{ locationIndex: 0, present: true }],
    [
      { locationIndex: 0, present: true },
      { locationIndex: 0, present: false },
    ],
    [
      { locationIndex: -1, present: true },
      { locationIndex: 1, present: false },
    ],
    [
      { locationIndex: 0, present: "yes" },
      { locationIndex: 1, present: false },
    ],
    [
      { locationIndex: 0, present: true, extra: true },
      { locationIndex: 1, present: false },
    ],
  ])("drops malformed configuration evidence atomically", async (candidate) => {
    const operations = probe();
    operations.inspectConfiguration = vi.fn().mockResolvedValue(candidate);
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered.configurationLocations).toEqual([]);
  });
});

describe("harness discovery authority containment", () => {
  it("contains hostile proxy traps in probe DTOs", async () => {
    const operations = probe();
    operations.locateExecutable = vi.fn().mockResolvedValue(
      new Proxy(
        { kind: "found", candidates: [{ path: "/bin/codex" }] },
        {
          getPrototypeOf() {
            throw new Error("CANARY");
          },
        },
      ),
    );
    const discovered = await discoverHarness(
      registry,
      descriptor.harnessType,
      operations,
    );
    expect(discovered.reason).toBe("probe-unavailable");

    const array = new Proxy([{ path: "/bin/codex" }], {
      ownKeys() {
        throw new Error("CANARY");
      },
    });
    const second = probe({ kind: "found", candidates: array });
    await expect(
      discoverHarness(registry, descriptor.harnessType, second),
    ).resolves.toMatchObject({
      reason: "probe-unavailable",
    });

    const symbolArray = [{ path: "/bin/codex" }];
    Object.defineProperty(symbolArray, Symbol.iterator, {
      value: Array.prototype[Symbol.iterator],
    });
    const third = probe({ kind: "found", candidates: symbolArray });
    await expect(
      discoverHarness(registry, descriptor.harnessType, third),
    ).resolves.toMatchObject({
      reason: "probe-unavailable",
    });
  });

  it("extracts a version when the declared suffix is empty", async () => {
    const emptySuffixDescriptor = defineHarnessDescriptor({
      ...descriptorInput,
      executable: { ...descriptorInput.executable, versionSuffix: "" },
    });
    const emptySuffixRegistry = compileHarnessRegistry(
      [emptySuffixDescriptor],
      {
        manifestVersion: 1,
        entries: [
          {
            harnessType: emptySuffixDescriptor.harnessType,
            evidenceSlot: "stable-v1",
            testedVersion: "1.4.0",
            contractSuiteDigest: digest,
            realScenarioDigest: digest,
          },
        ],
      },
    );
    const operations = probe(undefined, {
      kind: "observed",
      output: "codex 1.4.0",
    });
    await expect(
      discoverHarness(
        emptySuffixRegistry,
        emptySuffixDescriptor.harnessType,
        operations,
      ),
    ).resolves.toMatchObject({ state: "installed", version: "1.4.0" });
  });

  it("rejects unbranded registries and unknown harness identities", async () => {
    await expect(
      discoverHarness({} as never, descriptor.harnessType, probe()),
    ).rejects.toThrow(HarnessDiscoveryError);
    await expect(
      discoverHarness(registry, "@agentscope/harness-other", probe()),
    ).rejects.toThrow(HarnessDiscoveryError);
  });
});
