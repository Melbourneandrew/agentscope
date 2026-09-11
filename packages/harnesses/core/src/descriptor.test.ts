import { describe, expect, it } from "vitest";

import {
  HarnessDescriptorError,
  defineHarnessDescriptor,
  defineHarnessRegistry,
  getHarnessDescriptor,
  isHarnessDescriptor,
  isHarnessRegistry,
} from "./descriptor.js";
import {
  compareStableSemver,
  parseStableSemver,
  stableSemverIsInRange,
} from "./semver.js";
import type { HarnessDescriptorInput } from "./types.js";
import { harnessesCorePackageId } from "./index.js";

const input = (
  overrides: Partial<HarnessDescriptorInput> = {},
): HarnessDescriptorInput => ({
  descriptorVersion: 1,
  harnessType: "@agentscope/harness-codex",
  executable: {
    names: ["codex"],
    versionArguments: ["--version"],
    versionPrefix: "codex ",
    versionSuffix: "",
  },
  configuration: { locationSegments: [[".codex", "config.toml"]] },
  compatibility: [
    {
      minimumInclusive: "1.2.0",
      maximumExclusive: "2.0.0",
      evidenceSlot: "stable-v1",
    },
  ],
  nativeSource: { sourceKind: "codex-session", continuityVersion: 1 },
  ...overrides,
});

describe("stable semver", () => {
  it("parses and compares canonical stable versions", () => {
    const first = parseStableSemver("1.2.3")!;
    const second = parseStableSemver("1.3.0")!;
    expect(first).toEqual({ major: 1, minor: 2, patch: 3, text: "1.2.3" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(compareStableSemver(first, first)).toBe(0);
    expect(compareStableSemver(first, second)).toBe(-1);
    expect(compareStableSemver(second, first)).toBe(1);
    expect(stableSemverIsInRange(first, first, second)).toBe(true);
    expect(stableSemverIsInRange(second, first, second)).toBe(false);
  });

  it.each(["", "01.2.3", "1.2", "1.2.3-beta", "2147483648.0.0"])(
    "rejects noncanonical version %s",
    (value) => {
      expect(parseStableSemver(value)).toBeUndefined();
    },
  );
});

describe("harness descriptor registry", () => {
  it("registers branded descriptors without accepting support evidence", () => {
    expect(harnessesCorePackageId).toBe("@agentscope/harnesses-core");
    const descriptor = defineHarnessDescriptor(input());
    const registry = defineHarnessRegistry([descriptor]);
    expect(isHarnessDescriptor(descriptor)).toBe(true);
    expect(isHarnessRegistry(registry)).toBe(true);
    expect(registry.harnessTypes).toEqual(["@agentscope/harness-codex"]);
    expect(getHarnessDescriptor(registry, descriptor.harnessType)).toBe(
      descriptor,
    );
    expect(
      getHarnessDescriptor(registry, "@agentscope/harness-missing"),
    ).toBeUndefined();
    expect(Object.isFrozen(descriptor.executable.names)).toBe(true);
    expect(Object.isFrozen(registry.harnessTypes)).toBe(true);
  });

  it.each([
    input({ descriptorVersion: 2 as 1 }),
    input({ harnessType: "codex" }),
    input({ executable: { ...input().executable, names: ["../codex"] } }),
    input({ compatibility: [] }),
    input({
      compatibility: [
        {
          minimumInclusive: "1.0.0",
          maximumExclusive: "1.0.0",
          evidenceSlot: "empty",
        },
      ],
    }),
    input({ executable: { ...input().executable, names: ["codex", "codex"] } }),
    input({ nativeSource: { sourceKind: "Codex", continuityVersion: 1 } }),
    input({ nativeSource: { sourceKind: "codex", continuityVersion: 0 } }),
    input({
      compatibility: [
        {
          minimumInclusive: "1.0.0",
          maximumExclusive: "2.0.0",
          evidenceSlot: "same",
        },
        {
          minimumInclusive: "2.0.0",
          maximumExclusive: "3.0.0",
          evidenceSlot: "same",
        },
      ],
    }),
    input({
      compatibility: [
        ...input().compatibility,
        {
          minimumInclusive: "1.5.0",
          maximumExclusive: "3.0.0",
          evidenceSlot: "overlap",
        },
      ],
    }),
  ])("rejects an invalid descriptor", (candidate) => {
    expect(() => defineHarnessDescriptor(candidate)).toThrow(
      HarnessDescriptorError,
    );
  });

  it("rejects duplicate descriptor identities and unbranded descriptors", () => {
    const descriptor = defineHarnessDescriptor(input());
    expect(() => defineHarnessRegistry([descriptor, descriptor])).toThrow(
      HarnessDescriptorError,
    );
    expect(() => defineHarnessRegistry([input() as never])).toThrow(
      HarnessDescriptorError,
    );
    expect(() =>
      (defineHarnessRegistry as (...values: unknown[]) => unknown)(
        [descriptor],
        { manifestVersion: 1 },
      ),
    ).toThrow(HarnessDescriptorError);
    expect(isHarnessDescriptor(input())).toBe(false);
    expect(isHarnessRegistry(Object.freeze({}))).toBe(false);
  });
});

describe("harness descriptor hostile boundaries", () => {
  it("rejects accessor, sparse, symbol, and custom-iterator input without execution", () => {
    let reads = 0;
    const accessor = input();
    Object.defineProperty(accessor, "harnessType", {
      get() {
        reads += 1;
        return "@agentscope/harness-codex";
      },
      enumerable: true,
    });
    expect(() => defineHarnessDescriptor(accessor)).toThrow(
      HarnessDescriptorError,
    );
    expect(reads).toBe(0);

    const sparse = new Array(1) as HarnessDescriptorInput["compatibility"];
    expect(() =>
      defineHarnessDescriptor(input({ compatibility: sparse })),
    ).toThrow(HarnessDescriptorError);

    const names = ["codex"];
    Object.defineProperty(names, Symbol.iterator, {
      value: () => {
        throw new Error("CANARY");
      },
    });
    expect(() =>
      defineHarnessDescriptor(
        input({ executable: { ...input().executable, names } }),
      ),
    ).toThrow(HarnessDescriptorError);
  });

  it("rejects hostile records and arrays with fixed errors", () => {
    expect(() => defineHarnessDescriptor(null as never)).toThrow(
      HarnessDescriptorError,
    );
    expect(() => defineHarnessDescriptor([] as never)).toThrow(
      HarnessDescriptorError,
    );
    expect(() =>
      defineHarnessDescriptor({ ...input(), extra: true } as never),
    ).toThrow(HarnessDescriptorError);
    expect(() =>
      defineHarnessDescriptor(
        new Proxy(input(), {
          getPrototypeOf() {
            throw new Error("CANARY");
          },
        }),
      ),
    ).toThrow(HarnessDescriptorError);
    expect(() =>
      defineHarnessDescriptor(
        new Proxy(input(), {
          ownKeys() {
            throw new Error("CANARY");
          },
        }),
      ),
    ).toThrow(HarnessDescriptorError);
    expect(() =>
      defineHarnessDescriptor(
        input({ executable: { ...input().executable, names: null as never } }),
      ),
    ).toThrow(HarnessDescriptorError);
  });

  it("supports distinct nonoverlapping eligible ranges and empty affixes", () => {
    const descriptor = defineHarnessDescriptor(
      input({
        executable: {
          ...input().executable,
          versionPrefix: "",
          versionSuffix: "",
        },
        compatibility: [
          {
            minimumInclusive: "1.0.0",
            maximumExclusive: "2.0.0",
            evidenceSlot: "v1",
          },
          {
            minimumInclusive: "2.0.0",
            maximumExclusive: "3.0.0",
            evidenceSlot: "v2",
          },
        ],
      }),
    );
    expect(defineHarnessRegistry([descriptor])).toBeDefined();
  });
});
