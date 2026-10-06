import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDestinationRegistry } from "@agentscope/destinations-core";

import {
  createCredentialOwnership,
  deriveStoredCredentialReference,
  createCiEnvironmentCredentialReference,
  compileCredentialBackendRegistry,
  createCredentialResolutionContext,
  defineStoredCredentialBackendAdapter,
} from "./credential-adapter.js";
import {
  canonicalCredentialIntent,
  parseCredentialIntentRecord,
} from "./credential-intent-record.js";
import {
  configureCredentialSetForCore,
  recoverCredentialSetForCore,
  type ConfigureCredentialSetInput,
} from "./credential-set-lifecycle.js";
import { createAgentscopeHomeResolver } from "./home.js";
import {
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createCredentialMutationIntent,
} from "./transaction.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const inputFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-intent-input-"));
  roots.push(root);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(root, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  let calls = 0;
  const unexpected = (): Promise<never> => {
    calls += 1;
    return Promise.reject(new Error("unexpected-backend-call"));
  };
  const registry = compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: unexpected,
      resolve: unexpected,
      activate: unexpected,
      removePending: unexpected,
      removeOwned: unexpected,
    }),
  ]);
  const controller = new AbortController();
  const input: ConfigureCredentialSetInput = {
    store: createConfigurationStore(home, compileDestinationRegistry([])),
    owner: createConfigurationProcessIdentity(
      1,
      `process-start-v1-${"a".repeat(64)}`,
    ),
    expectedGeneration: null,
    backend: "macos-keychain",
    requests: [
      { ownership: entry("api-key").ownership, secret: "private-canary" },
    ],
    resolutionContext: createCredentialResolutionContext(
      "hook-equivalent",
      controller.signal,
    ),
    createCandidate: () => {
      throw new Error("unexpected-candidate-call");
    },
  };
  return { root, registry, input, controller, calls: () => calls };
};

const owner = {
  processId: 1,
  processStartIdentity: `process-start-v1-${"a".repeat(64)}`,
};
const entry = (slot: string, generation = "b") => {
  const ownership = createCredentialOwnership({
    destinationType: "@agentscope/destination-example",
    connectionId: `destination-connection-v1-${"c".repeat(64)}`,
    slot,
  });
  return {
    ownership,
    reference: deriveStoredCredentialReference(
      "macos-keychain",
      ownership,
      `credential-generation-v1-${generation.repeat(64)}`,
    ),
  };
};
const set = () => ({
  recordVersion: 2,
  operation: "create",
  owner,
  entries: [entry("public-key"), entry("secret-key", "d")],
});

describe("versioned retirement record codec", () => {
  const retirement = () => ({
    ...set(),
    recordVersion: 3,
    operation: "retire",
    preimage: { generation: 4, digest: `sha256-${"a".repeat(64)}` },
    removal: { generation: 5, digest: `sha256-${"b".repeat(64)}` },
    final: { generation: 6, digest: `sha256-${"c".repeat(64)}` },
  });
  it("freezes one distinct v3 record and preserves exact canonical round trip", () => {
    const value = canonicalCredentialIntent(retirement());
    expect(parseCredentialIntentRecord(`${JSON.stringify(value)}\n`)).toEqual(
      value,
    );
    expect(Object.isFrozen(value)).toBe(true);
    if (value.recordVersion !== 3) throw new Error("unexpected-version");
    expect(Object.isFrozen(value.final)).toBe(true);
    expect(Object.isFrozen(value.entries)).toBe(true);
  });
  it.each([
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      operation: "create",
    }),
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      removal: { ...value.removal, generation: 6 },
    }),
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      final: { ...value.final, generation: 7 },
    }),
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      final: { ...value.final, digest: value.removal.digest },
    }),
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      preimage: { ...value.preimage, extra: true },
    }),
    (value: ReturnType<typeof retirement>) => ({
      ...value,
      entries: [...value.entries].reverse(),
    }),
  ])("rejects malformed retirement record %#", (change) => {
    expect(() => canonicalCredentialIntent(change(retirement()))).toThrow();
  });
});

describe("credential set input record refuses before intent or backend mutation", () => {
  const changes: readonly ((input: ConfigureCredentialSetInput) => unknown)[] =
    [
      () => null,
      (input) => new Proxy(input, {}),
      (input) => ({ ...input, unknown: true }),
      (input) => ({ ...input, [Symbol("unexpected")]: 1 }),
      (input) => ({ ...input, store: {} }),
      (input) => ({ ...input, owner: {} }),
      (input) => ({ ...input, resolutionContext: {} }),
      (input) => ({ ...input, createCandidate: null }),
      (input) => ({ ...input, expectedGeneration: -1 }),
      (input) => ({ ...input, expectedGeneration: 0.5 }),
      (input) => ({ ...input, requests: null }),
      (input) => ({ ...input, requests: new Proxy([], {}) }),
      (input) => ({ ...input, requests: [] }),
      (input) => ({
        ...input,
        requests: Array.from({ length: 17 }, () => input.requests[0]),
      }),
      (input) => ({
        ...input,
        requests: Object.assign([...input.requests], { extra: true }),
      }),
      (input) => ({
        ...input,
        requests: [{ ownership: {}, secret: "canary" }],
      }),
      ...[null, "", "\0", "\ud800", "x".repeat(8_193)].map(
        (secret) => (input: ConfigureCredentialSetInput) => ({
          ...input,
          requests: [{ ownership: input.requests[0]?.ownership, secret }],
        }),
      ),
    ];
  it.each(changes)(
    "rejects malformed input %# without publication or backend calls",
    async (change) => {
      const value = await inputFixture();
      await expect(
        configureCredentialSetForCore(
          value.registry,
          change(value.input) as ConfigureCredentialSetInput,
        ),
      ).rejects.toThrow();
      expect(value.calls()).toBe(0);
      expect(await readdir(value.root)).toEqual([]);
    },
  );
  it("refuses accessors and sparse/accessor arrays without executing getters", async () => {
    const value = await inputFixture();
    let reads = 0;
    const input = { ...value.input };
    Object.defineProperty(input, "backend", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "macos-keychain";
      },
    });
    await expect(
      configureCredentialSetForCore(value.registry, input),
    ).rejects.toThrow();
    const requests = new Array<ConfigureCredentialSetInput["requests"][number]>(
      1,
    );
    await expect(
      configureCredentialSetForCore(value.registry, {
        ...value.input,
        requests,
      }),
    ).rejects.toThrow();
    Object.defineProperty(requests, "0", {
      enumerable: true,
      get: () => {
        reads += 1;
        return value.input.requests[0];
      },
    });
    await expect(
      configureCredentialSetForCore(value.registry, {
        ...value.input,
        requests,
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
    expect(value.calls()).toBe(0);
    expect(await readdir(value.root)).toEqual([]);
  });
  it("admits no credential call after cancellation at entry", async () => {
    const value = await inputFixture();
    value.controller.abort();
    await expect(
      configureCredentialSetForCore(value.registry, value.input),
    ).rejects.toThrow();
    expect(value.calls()).toBe(0);
    expect(await readdir(value.root)).toEqual([]);
  });
});
const encoded = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("canonical credential mutation records", () => {
  it.each(["create", "retire"])(
    "preserves the existing version-1 %s representation",
    (operation) => {
      const value = { recordVersion: 1, operation, owner, ...entry("api-key") };
      expect(encoded(parseCredentialIntentRecord(encoded(value)))).toBe(
        encoded(value),
      );
    },
  );
  it("preserves a version-1 CI reference but rejects it in a stored set", () => {
    const value = {
      ...entry("api-key"),
      reference: createCiEnvironmentCredentialReference(
        "API_KEY",
        `credential-generation-v1-${"d".repeat(64)}`,
      ),
    };
    const single = { recordVersion: 1, operation: "create", owner, ...value };
    expect(encoded(parseCredentialIntentRecord(encoded(single)))).toBe(
      encoded(single),
    );
    expect(() =>
      parseCredentialIntentRecord(encoded({ ...set(), entries: [value] })),
    ).toThrow();
  });

  it("freezes a complete canonical set without any secret field", () => {
    const value = parseCredentialIntentRecord(encoded(set()));
    expect(Object.isFrozen(value)).toBe(true);
    if (value.recordVersion !== 2) throw new Error();
    expect(Object.isFrozen(value.entries)).toBe(true);
    expect(Object.isFrozen(value.entries[0]?.ownership)).toBe(true);
    expect(encoded(value)).not.toContain("secret-value");
  });

  it.each([
    () => ({ ...set(), operation: "retire" }),
    () => ({ ...set(), recordVersion: 3 }),
    () => ({ ...set(), entries: [] }),
    () => ({
      ...set(),
      entries: Array.from({ length: 17 }, () => entry("api-key")),
    }),
    () => ({ ...set(), entries: [entry("secret-key"), entry("public-key")] }),
    () => ({ ...set(), entries: [entry("api-key"), entry("api-key", "d")] }),
    () => ({ ...set(), secret: "secret-value" }),
    () => ({
      ...set(),
      entries: [{ ...entry("api-key"), secret: "secret-value" }],
    }),
    () => ({
      ...set(),
      entries: [
        { ...entry("api-key"), reference: entry("other-slot").reference },
      ],
    }),
    () => ({
      ...set(),
      entries: [
        {
          ...entry("api-key"),
          ownership: {
            ...entry("api-key").ownership,
            connectionId: `destination-connection-v1-${"e".repeat(64)}`,
          },
        },
      ],
    }),
  ])("rejects an invalid set record %#", (mutate) => {
    expect(() => parseCredentialIntentRecord(encoded(mutate()))).toThrow();
  });

  it("retains the original 4096-byte record ceiling", () => {
    const value = {
      ...set(),
      entries: Array.from({ length: 16 }, (_, index) =>
        entry(`slot-${String(index).padStart(2, "0")}`),
      ),
    };
    expect(Buffer.byteLength(encoded(value))).toBeGreaterThan(4_096);
    expect(() => parseCredentialIntentRecord(encoded(value))).toThrow();
  });

  it.each([
    (value: string) => value.trim(),
    (value: string) => ` ${value}`,
    (value: string) =>
      value.replace('"recordVersion":2', '"recordVersion":2,"recordVersion":2'),
  ])("rejects noncanonical bytes %#", (mutate: (value: string) => string) => {
    expect(() => parseCredentialIntentRecord(mutate(encoded(set())))).toThrow();
  });
});

describe("credential intent hostile object reconstruction", () => {
  it("refuses a second operation while the original intent remains", async () => {
    const value = await inputFixture();
    await configureCredentialSetForCore(value.registry, value.input);
    expect(
      await configureCredentialSetForCore(value.registry, value.input),
    ).toMatchObject({
      state: "compensated",
      code: "core.credential.create-failed",
    });
    expect(value.calls()).toBe(1);
  });
  it("refuses cloned and cancelled minted set authorities", async () => {
    const value = await inputFixture();
    const intent = await createCredentialMutationIntent(value.input.store, {
      recordVersion: 2,
      operation: "create",
      owner: value.input.owner,
      entries: [entry("api-key")],
    });
    await expect(
      recoverCredentialSetForCore(
        value.registry,
        value.input.store,
        { ...intent },
        value.input.resolutionContext,
      ),
    ).rejects.toThrow();
    value.controller.abort();
    await expect(
      recoverCredentialSetForCore(
        value.registry,
        value.input.store,
        intent,
        value.input.resolutionContext,
      ),
    ).rejects.toThrow();
    expect(value.calls()).toBe(0);
  });
  it("refuses accessors without reading credential content", () => {
    let calls = 0;
    const value = { ...set() };
    Object.defineProperty(value, "entries", {
      enumerable: true,
      get: () => {
        calls += 1;
        return [];
      },
    });
    expect(() => canonicalCredentialIntent(value)).toThrow();
    expect(calls).toBe(0);
  });

  it("rejects nested proxies without executing traps", () => {
    let calls = 0;
    const value = set();
    value.entries[0] = new Proxy(entry("public-key"), {
      ownKeys: () => {
        calls += 1;
        throw new Error();
      },
      getPrototypeOf: () => {
        calls += 1;
        throw new Error();
      },
    });
    expect(() => canonicalCredentialIntent(value)).toThrow();
    expect(calls).toBe(0);
  });
  it("rejects an excessive input key inventory before reconstruction", () => {
    expect(() =>
      canonicalCredentialIntent(
        Object.fromEntries(
          Array.from({ length: 18 }, (_, index) => [String(index), index]),
        ),
      ),
    ).toThrow();
  });
});
