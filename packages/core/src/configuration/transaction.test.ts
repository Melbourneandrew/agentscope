import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readFileSync,
  rm,
  symlink,
  writeFile,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  link as nodeLink,
  open as nodeOpen,
  rename as nodeRename,
  unlink as nodeUnlink,
} from "node:fs/promises";

import { compileDestinationRegistry } from "@agentscope/destinations-core";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentscopeHomeResolver } from "./home.js";
import {
  createCiEnvironmentCredentialReference,
  createCredentialOwnership,
  createStoredCredentialReference,
} from "./credential-adapter.js";
import {
  parseAgentscopeConfiguration,
  serializeAgentscopeConfiguration,
} from "./schema.js";
import {
  ConfigurationCrashSimulation,
  ConfigurationStoreError,
  MAXIMUM_CONFIGURATION_FILE_BYTES,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createConfigurationStoreForTesting,
  createCredentialMutationIntent,
  createLocalResourceMutationIntent,
  completeCredentialMutationIntent,
  completeLocalResourceMutationIntent,
  finalizeLocalResourceMutationCompletion,
  inspectCredentialMutation,
  inspectConfigurationTransaction,
  inspectLocalResourceMutation,
  readConfigurationForHook,
  readConfigurationSnapshot,
  readRecoverableCredentialMutationIntent,
  readRecoverableLocalResourceMutationIntent,
  recoverAbandonedConfigurationTransaction,
  writeConfigurationSnapshot,
  type ConfigurationTransactionStep,
} from "./transaction.js";

const mkdirAsync = promisify(mkdir);
const mkdtempAsync = promisify(mkdtemp);
const readFileAsync = promisify(readFile);
const rmAsync = promisify(rm);
const writeFileAsync = promisify(writeFile);
const chmodAsync = promisify(chmod);
const lstatAsync = promisify(lstat);
const accessAsync = promisify(access);
const symlinkAsync = promisify(symlink);
const registry = compileDestinationRegistry([]);
const owner = createConfigurationProcessIdentity(
  42,
  `process-start-v1-${"a".repeat(64)}`,
);
const roots: string[] = [];
const credentialOwnership = createCredentialOwnership({
  destinationType: "@agentscope/destination-example",
  connectionId: `destination-connection-v1-${"b".repeat(64)}`,
  slot: "api-key",
});
const credentialReference = createStoredCredentialReference(
  "macos-keychain",
  `credential-reference-v1-${"c".repeat(64)}`,
  `credential-generation-v1-${"d".repeat(64)}`,
);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rmAsync(root, { recursive: true, force: true })),
  );
});

const homeFixture = async () => {
  const parent = await mkdtempAsync(join(tmpdir(), "agentscope-config-store-"));
  roots.push(parent);
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: join(parent, "home") },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  return { home, store: createConfigurationStore(home, registry) };
};

const document = (generation: number, reference = "policy-v1") => ({
  configurationVersion: 2,
  generation,
  destinations: {},
  routing: {
    version: 1,
    selectedConnectionIds: [],
    hookDeadlineMilliseconds: 2_000,
  },
  policy: { version: 1, reference },
});

const snapshot = (generation: number, reference?: string) =>
  parseAgentscopeConfiguration(document(generation, reference), registry);
const snapshotText = (generation: number, reference?: string) =>
  serializeAgentscopeConfiguration(snapshot(generation, reference));
const snapshotDigest = (value: ReturnType<typeof snapshot>): string =>
  `sha256-${createHash("sha256")
    .update(serializeAgentscopeConfiguration(value))
    .digest("hex")}`;

const errorCode = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
    return "resolved";
  } catch (error) {
    return error instanceof ConfigurationStoreError ? error.code : "other";
  }
};

// eslint-disable-next-line max-lines-per-function -- the suite shares one filesystem cleanup and generation fixture.
describe("fenced configuration writes", () => {
  it("removes the completion authority last across cleanup crashes", async () => {
    const { home } = await homeFixture();
    let failCleanup = false;
    let cleanupUnlinks = 0;
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        link: nodeLink,
        open: nodeOpen,
        rename: nodeRename,
        unlink: async (path) => {
          if (failCleanup) {
            cleanupUnlinks += 1;
            if (cleanupUnlinks === 2) throw new Error("simulated crash");
          }
          await nodeUnlink(path);
        },
      },
    });
    const initial = snapshot(0);
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: initial,
      owner,
    });
    const intent = await createLocalResourceMutationIntent(store, {
      recordVersion: 1,
      operation: "configure",
      operationId: "8".repeat(32),
      owner,
      destinationType: "@agentscope/destination-example",
      connectionId: `destination-connection-v1-${"b".repeat(64)}`,
      lifecycleFingerprint: `sha256-${"c".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-example/lifecycle-v1",
      expectedGeneration: 0,
      expectedDigest: snapshotDigest(initial),
      authorizedCandidates: Object.freeze([
        Object.freeze({
          generation: 1,
          digest: snapshotDigest(snapshot(1, "policy-a")),
        }),
      ]),
    });
    await completeLocalResourceMutationIntent(store, intent);
    await nodeLink(
      join(home.mutationDirectory, "local-resource.completion.lock"),
      join(home.mutationDirectory, "local-resource.recovery.lock"),
    );
    failCleanup = true;
    await expect(
      finalizeLocalResourceMutationCompletion(store, intent),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });
    failCleanup = false;
    await expect(
      inspectLocalResourceMutation(store, () => "unknown"),
    ).resolves.toEqual({ state: "recoverable" });
    const recovered = await readRecoverableLocalResourceMutationIntent(
      store,
      () => "unknown",
    );
    await finalizeLocalResourceMutationCompletion(store, recovered);
    await expect(
      inspectLocalResourceMutation(store, () => "unknown"),
    ).resolves.toEqual({ state: "clean" });
  });

  it("reciprocally fences the exact Local-resource candidate sequence", async () => {
    const { store } = await homeFixture();
    const initial = snapshot(0);
    const first = snapshot(1, "policy-a");
    const final = snapshot(2, "policy-a");
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: initial,
      owner,
    });
    const intent = await createLocalResourceMutationIntent(store, {
      recordVersion: 1,
      operation: "delete",
      operationId: "1".repeat(32),
      owner,
      destinationType: "@agentscope/destination-example",
      connectionId: `destination-connection-v1-${"b".repeat(64)}`,
      lifecycleFingerprint: `sha256-${"c".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-example/lifecycle-v1",
      expectedGeneration: 0,
      expectedDigest: snapshotDigest(initial),
      authorizedCandidates: Object.freeze([
        Object.freeze({ generation: 1, digest: snapshotDigest(first) }),
        Object.freeze({ generation: 2, digest: snapshotDigest(final) }),
      ]),
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: 0,
        candidate: first,
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 0,
      candidate: first,
      owner,
      localResourceMutationIntent: intent,
    });
    await writeConfigurationSnapshot(store, {
      expectedGeneration: 1,
      candidate: final,
      owner,
      localResourceMutationIntent: intent,
    });
    await completeLocalResourceMutationIntent(store, intent);
    await expect(
      inspectLocalResourceMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "recoverable" });
    const completed = await readRecoverableLocalResourceMutationIntent(
      store,
      () => "unknown",
    );
    expect(completed).toEqual(intent);
    await completeLocalResourceMutationIntent(store, completed);
    await finalizeLocalResourceMutationCompletion(store, completed);
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 2,
    });

    const recoverable = await createLocalResourceMutationIntent(store, {
      recordVersion: 1,
      operation: "unconfigure",
      operationId: "2".repeat(32),
      owner,
      destinationType: "@agentscope/destination-example",
      connectionId: `destination-connection-v1-${"b".repeat(64)}`,
      lifecycleFingerprint: `sha256-${"c".repeat(64)}`,
      recoveryHandlerId: "@agentscope/destination-example/lifecycle-v1",
      expectedGeneration: 2,
      expectedDigest: snapshotDigest(final),
      authorizedCandidates: Object.freeze([
        Object.freeze({
          generation: 3,
          digest: snapshotDigest(snapshot(3, "policy-a")),
        }),
      ]),
    });
    await expect(
      inspectLocalResourceMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "recoverable" });
    const claimed = await readRecoverableLocalResourceMutationIntent(
      store,
      () => "dead",
    );
    expect(claimed).toEqual(recoverable);
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: 2,
        candidate: snapshot(3, "policy-a"),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await completeLocalResourceMutationIntent(store, claimed);
    await finalizeLocalResourceMutationCompletion(store, claimed);
  });

  it("atomically creates and then replaces the active generation", async () => {
    const { home, store } = await homeFixture();
    const first = snapshot(0);
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: first,
        owner,
      }),
    ).resolves.toBe(first);
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 0,
    });
    const firstMode = (await lstatAsync(home.configFile)).mode & 0o777;
    expect(firstMode).toBe(0o600);
    await expect(accessAsync(home.configBackupFile)).rejects.toBeDefined();

    const second = snapshot(1, "policy-v2");
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: 0,
        candidate: second,
        owner,
      }),
    ).resolves.toBe(second);
    expect(JSON.parse(await readFileAsync(home.configFile, "utf8"))).toEqual(
      document(1, "policy-v2"),
    );
    expect(
      JSON.parse(await readFileAsync(home.configBackupFile, "utf8")),
    ).toEqual(document(0));
    expect((await lstatAsync(home.configBackupFile)).mode & 0o777).toBe(0o600);
    await expect(
      accessAsync(join(home.mutationDirectory, "config.lock")),
    ).rejects.toBeDefined();
  });

  it("fences stale, skipped, and concurrent writers", async () => {
    const { store } = await homeFixture();
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
    });
    expect(
      await errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: null,
          candidate: snapshot(0),
          owner,
        }),
      ),
    ).toBe("core.configuration.conflict");
    expect(
      await errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: 0,
          candidate: snapshot(2),
          owner,
        }),
      ),
    ).toBe("core.configuration.conflict");

    const outcomes = await Promise.all([
      errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: 0,
          candidate: snapshot(1, "policy-a"),
          owner,
        }),
      ),
      errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: 0,
          candidate: snapshot(1, "policy-b"),
          owner,
        }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome === "resolved")).toHaveLength(
      1,
    );
    expect(
      outcomes.some((outcome) =>
        [
          "core.configuration.contention",
          "core.configuration.conflict",
        ].includes(outcome),
      ),
    ).toBe(true);
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 1,
    });
  });
});

describe("configuration contention and revalidation", () => {
  it("does not overwrite a same-generation external change", async () => {
    const { home } = await homeFixture();
    const initialStore = createConfigurationStore(home, registry);
    await writeConfigurationSnapshot(initialStore, {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
    });
    const changed = snapshotText(0, "external-policy");
    const store = createConfigurationStoreForTesting(home, registry, {
      afterStep: (step) => {
        if (step === "candidate-durable")
          writeFileSync(home.configFile, changed, { encoding: "utf8" });
      },
    });
    expect(
      await errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: 0,
          candidate: snapshot(1),
          owner,
        }),
      ),
    ).toBe("core.configuration.conflict");
    expect(await readFileAsync(home.configFile, "utf8")).toBe(changed);
  });

  it("reports contention without interpreting another owner's lock", async () => {
    const { home, store } = await homeFixture();
    await mkdirAsync(home.mutationDirectory, { recursive: true, mode: 0o700 });
    await writeFileAsync(
      join(home.mutationDirectory, "config.lock"),
      "hostile",
    );
    expect(
      await errorCode(
        writeConfigurationSnapshot(store, {
          expectedGeneration: null,
          candidate: snapshot(0),
          owner,
        }),
      ),
    ).toBe("core.configuration.contention");
  });
});

describe("configuration mutation authority validation", () => {
  it("rejects forged stores, owners, homes, and transaction identities", async () => {
    const { home } = await homeFixture();
    expect(() => createConfigurationStore({ ...home }, registry)).toThrowError(
      ConfigurationStoreError,
    );
    await expect(
      readConfigurationSnapshot({ configurationStore: "agentscope-core" }),
    ).rejects.toThrowError(ConfigurationStoreError);
    expect(() =>
      createConfigurationProcessIdentity(0, "process-start-v1-invalid"),
    ).toThrowError(ConfigurationStoreError);
    const store = createConfigurationStoreForTesting(home, registry, {
      createTransactionId: () => "invalid",
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationStoreError);
    expect(() => createConfigurationStore(home, {} as never)).toThrowError(
      ConfigurationStoreError,
    );
  });

  it("rejects hostile write records without invoking accessors or creating state", async () => {
    const { home, store } = await homeFixture();
    let getterCalls = 0;
    const accessorInput = Object.defineProperty(
      {
        expectedGeneration: null,
        owner,
      },
      "candidate",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return snapshot(0);
        },
      },
    );
    const extraInput = {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
      extra: true,
    };
    const symbolInput = {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
      [Symbol("hostile")]: true,
    };
    const forgedOwner = {
      processId: owner.processId,
      processStartIdentity: owner.processStartIdentity,
    };
    for (const input of [
      null,
      accessorInput,
      extraInput,
      symbolInput,
      { expectedGeneration: -1, candidate: snapshot(0), owner },
      { expectedGeneration: null, candidate: snapshot(0), owner: forgedOwner },
    ])
      await expect(
        writeConfigurationSnapshot(store, input as never),
      ).rejects.toMatchObject({ code: "core.configuration.invalid" });
    expect(getterCalls).toBe(0);
    await expect(accessAsync(home.root)).rejects.toBeDefined();
  });

  it("refuses downgrade-unsafe candidates before creating configuration state", async () => {
    const { home, store } = await homeFixture();
    const unsupported = parseAgentscopeConfiguration(
      {
        ...document(0),
        destinations: { "@agentscope/destination-future": { version: 9 } },
      },
      registry,
    );
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: unsupported,
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.downgrade" });
    await expect(accessAsync(home.root)).rejects.toBeDefined();
  });
});

describe("configuration filesystem failure boundaries", () => {
  it("normalizes layout and post-lock failures to fixed store errors", async () => {
    const { home, store } = await homeFixture();
    await writeFileAsync(home.root, "not-a-directory");
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });
    await rmAsync(home.root, { force: true });

    const failing = createConfigurationStoreForTesting(home, registry, {
      afterStep: (step) => {
        if (step === "candidate-durable") throw new Error("CANARY_SECRET");
      },
    });
    await expect(
      writeConfigurationSnapshot(failing, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });

    const cleanupFailing = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: nodeOpen,
        rename: nodeRename,
        unlink: () => Promise.reject(new Error("CANARY_SECRET")),
      },
      afterStep: (step) => {
        if (step === "candidate-durable") throw new Error("CANARY_SECRET");
      },
    });
    await expect(
      writeConfigurationSnapshot(cleanupFailing, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });
    await expect(
      accessAsync(join(home.mutationDirectory, "config.lock")),
    ).resolves.toBeUndefined();
  });
});

const crashingStore = (
  home: Awaited<ReturnType<typeof homeFixture>>["home"],
  step: ConfigurationTransactionStep,
) =>
  createConfigurationStoreForTesting(home, registry, {
    createTransactionId: () => `configuration-transaction-v1-${"b".repeat(64)}`,
    afterStep: (current) => {
      if (current === step) throw new ConfigurationCrashSimulation();
    },
  });

describe("abandoned configuration transaction recovery", () => {
  it("cleans a provably dead pre-commit transaction without creating config", async () => {
    const { home } = await homeFixture();
    const store = crashingStore(home, "candidate-durable");
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    const lock = join(home.mutationDirectory, "config.lock");
    const lockBefore = await readFileAsync(lock, "utf8");
    await expect(
      inspectConfigurationTransaction(store, () => "live"),
    ).resolves.toEqual({ state: "active" });
    await expect(
      inspectConfigurationTransaction(store, () => "unknown"),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({
      state: "recoverable",
      committed: false,
      generation: null,
    });
    expect(await readFileAsync(lock, "utf8")).toBe(lockBefore);
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "live"),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-live",
    });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "unknown"),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });
    await expect(
      inspectConfigurationTransaction(store, () => {
        throw new Error("CANARY_SECRET");
      }),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ recovered: true, committed: false, generation: null });
    await expect(readConfigurationSnapshot(store)).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
  });

  it("recognizes and cleans a committed transaction after a crash", async () => {
    const { home } = await homeFixture();
    const initialStore = createConfigurationStore(home, registry);
    await writeConfigurationSnapshot(initialStore, {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
    });
    const store = crashingStore(home, "active-replaced");
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: 0,
        candidate: snapshot(1),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ recovered: true, committed: true, generation: 1 });
    await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
      generation: 1,
    });
  });

  it("refuses recovery when active evidence conflicts", async () => {
    const { home } = await homeFixture();
    const store = crashingStore(home, "candidate-durable");
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await writeFileAsync(home.configFile, snapshotText(4));
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ state: "conflict" });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });
  });
});

describe("configuration recovery boundaries", () => {
  it("requires a present structurally valid lock record", async () => {
    const { home, store } = await homeFixture();
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ state: "clean" });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
    await mkdirAsync(home.mutationDirectory, { recursive: true });
    await writeFileAsync(
      join(home.mutationDirectory, "config.lock"),
      `${JSON.stringify({ recordVersion: 1 })}\n`,
    );
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });
  });
});

describe("configuration lock recovery claims", () => {
  it("contains lock substitution and recovery-claim races", async () => {
    const { home } = await homeFixture();
    const substituted = createConfigurationStoreForTesting(home, registry, {
      afterStep: (step) => {
        if (step !== "active-reverified") return;
        const lock = join(home.mutationDirectory, "config.lock");
        const record = JSON.parse(readFileSync(lock, "utf8")) as Record<
          string,
          unknown
        >;
        record.candidateDigest = "f".repeat(64);
        writeFileSync(lock, `${JSON.stringify(record)}\n`);
      },
    });
    await expect(
      writeConfigurationSnapshot(substituted, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });

    await rmAsync(home.root, { recursive: true, force: true });
    const renameFailure = createConfigurationStoreForTesting(home, registry, {
      afterStep: (step) => {
        if (step === "candidate-durable")
          throw new ConfigurationCrashSimulation();
      },
      fileSystem: {
        link: () => Promise.reject(new Error("CANARY_SECRET")),
        open: nodeOpen,
        rename: async (source, destination) => {
          await nodeRename(source, destination);
        },
        unlink: nodeUnlink,
      },
    });
    await expect(
      writeConfigurationSnapshot(renameFailure, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await expect(
      recoverAbandonedConfigurationTransaction(renameFailure, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });

    const ordinary = createConfigurationStore(home, registry);
    let probes = 0;
    await expect(
      recoverAbandonedConfigurationTransaction(ordinary, () =>
        probes++ === 0 ? "dead" : "unknown",
      ),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });

    const second = await homeFixture();
    const claimMutation = createConfigurationStoreForTesting(
      second.home,
      registry,
      {
        afterStep: (step) => {
          if (step === "candidate-durable")
            throw new ConfigurationCrashSimulation();
        },
        fileSystem: {
          link: async (source, destination) => {
            await nodeLink(source, destination);
            const record = JSON.parse(
              await readFileAsync(destination, "utf8"),
            ) as Record<string, unknown>;
            record.candidateDigest = "e".repeat(64);
            await writeFileAsync(destination, `${JSON.stringify(record)}\n`);
          },
          open: nodeOpen,
          rename: async (source, destination) => {
            await nodeRename(source, destination);
          },
          unlink: nodeUnlink,
        },
      },
    );
    await expect(
      writeConfigurationSnapshot(claimMutation, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await expect(
      recoverAbandonedConfigurationTransaction(claimMutation, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });
  });
});

describe("configuration recovery claim concurrency", () => {
  it("permits one recovery winner while blocking recoverers and writers", async () => {
    const { home } = await homeFixture();
    let linked!: () => void;
    let resume!: () => void;
    const linkObserved = new Promise<void>((resolve) => {
      linked = resolve;
    });
    const resumeLink = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = createConfigurationStoreForTesting(home, registry, {
      afterStep: (step) => {
        if (step === "candidate-durable")
          throw new ConfigurationCrashSimulation();
      },
      fileSystem: {
        link: async (source, destination) => {
          await nodeLink(source, destination);
          linked();
          await resumeLink;
        },
        open: nodeOpen,
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    const winner = recoverAbandonedConfigurationTransaction(
      store,
      () => "dead",
    );
    await linkObserved;
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ state: "reconciliation-required" });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    resume();
    await expect(winner).resolves.toEqual({
      recovered: true,
      committed: false,
      generation: null,
    });
  });

  it("abandons its exact lock if a recovery gate appears during acquisition", async () => {
    const { home } = await homeFixture();
    let claimReads = 0;
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("config.recovery.lock") &&
            ++claimReads === 2
          )
            await nodeLink(join(home.mutationDirectory, "config.lock"), path);
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await expect(readConfigurationSnapshot(store)).rejects.toMatchObject({
      code: "core.configuration.missing",
    });
  });
});

describe("configuration recovery claim substitution", () => {
  it("preserves a substituted configuration lock behind a recovery gate", async () => {
    const { home } = await homeFixture();
    let claimReads = 0;
    const lock = join(home.mutationDirectory, "config.lock");
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("config.recovery.lock") &&
            ++claimReads === 2
          ) {
            await nodeLink(lock, path);
            const record = JSON.parse(
              await readFileAsync(lock, "utf8"),
            ) as Record<string, unknown>;
            record.transactionId = `configuration-transaction-v1-${"f".repeat(64)}`;
            await writeFileAsync(lock, `${JSON.stringify(record)}\n`);
          }
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await expect(readFileAsync(lock, "utf8")).resolves.toContain("ffffffff");
  });
});

describe("configuration recovery hostile evidence", () => {
  it.each(["lock-durable", "backup-durable", "active-reverified"] as const)(
    "recovers a dead writer stopped after %s without advancing generation",
    async (step) => {
      const { home } = await homeFixture();
      const initialStore = createConfigurationStore(home, registry);
      await writeConfigurationSnapshot(initialStore, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      });
      const store = crashingStore(home, step);
      await expect(
        writeConfigurationSnapshot(store, {
          expectedGeneration: 0,
          candidate: snapshot(1),
          owner,
        }),
      ).rejects.toThrowError(ConfigurationCrashSimulation);
      await expect(
        recoverAbandonedConfigurationTransaction(store, () => "dead"),
      ).resolves.toEqual({ recovered: true, committed: false, generation: 0 });
      await expect(readConfigurationSnapshot(store)).resolves.toMatchObject({
        generation: 0,
      });
    },
  );

  it("rejects noncanonical lock evidence and safely observes async owner probes", async () => {
    const { home } = await homeFixture();
    const store = crashingStore(home, "candidate-durable");
    const crash = () =>
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      });
    await expect(crash()).rejects.toThrowError(ConfigurationCrashSimulation);
    const lock = join(home.mutationDirectory, "config.lock");
    await writeFileAsync(lock, `${await readFileAsync(lock, "utf8")}\n`);
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });

    await rmAsync(home.root, { recursive: true, force: true });
    await expect(crash()).rejects.toThrowError(ConfigurationCrashSimulation);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await expect(
        recoverAbandonedConfigurationTransaction(store, (() =>
          Promise.reject(new Error("CANARY_SECRET"))) as never),
      ).rejects.toMatchObject({
        code: "core.configuration.recovery-owner-unknown",
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("rejects throwing owner probes and transaction-path substitution", async () => {
    const { home } = await homeFixture();
    const store = crashingStore(home, "candidate-durable");
    const crash = () =>
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      });
    await expect(crash()).rejects.toThrowError(ConfigurationCrashSimulation);
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => {
        throw new Error("CANARY_SECRET");
      }),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });
    await expect(
      recoverAbandonedConfigurationTransaction(store, (() =>
        Promise.resolve("dead")) as never),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });

    const lock = join(home.mutationDirectory, "config.lock");
    const record = JSON.parse(await readFileAsync(lock, "utf8")) as Record<
      string,
      unknown
    >;
    record.candidateFileName = `.config.${"c".repeat(64)}.candidate`;
    await writeFileAsync(lock, `${JSON.stringify(record)}\n`);
    await expect(
      inspectConfigurationTransaction(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await expect(
      recoverAbandonedConfigurationTransaction(store, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });
  });
});

describe("credential mutation intent journal", () => {
  it("records one exact owner-bound intent and clears only that intent", async () => {
    const { home, store } = await homeFixture();
    const intent = await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    expect(
      (await lstatAsync(join(home.mutationDirectory, "credential.lock"))).mode &
        0o777,
    ).toBe(0o600);
    await expect(
      inspectCredentialMutation(store, () => "live"),
    ).resolves.toEqual({ state: "active" });
    await expect(
      inspectCredentialMutation(store, () => "unknown"),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      inspectCredentialMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "recoverable" });
    const recovered = await readRecoverableCredentialMutationIntent(
      store,
      () => "dead",
    );
    expect(recovered).toEqual(intent);
    await expect(
      createCredentialMutationIntent(store, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await completeCredentialMutationIntent(store, recovered);
    await expect(
      inspectCredentialMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "clean" });
    const ciIntent = await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: createCiEnvironmentCredentialReference(
        "AGENTSCOPE_KEY",
        `credential-generation-v1-${"f".repeat(64)}`,
      ),
    });
    await completeCredentialMutationIntent(store, ciIntent);
  });

  it("rejects a completed intent as configuration-write authority", async () => {
    const { store } = await homeFixture();
    const intent = await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    await completeCredentialMutationIntent(store, intent);
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
        credentialMutationIntent: intent,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });
  });
});

describe("credential recovery claim concurrency", () => {
  it("admits one credential recovery claim and blocks replacement intents", async () => {
    const { home, store } = await homeFixture();
    await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    let linked!: () => void;
    let resume!: () => void;
    const linkObserved = new Promise<void>((resolve) => {
      linked = resolve;
    });
    const resumeLink = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const recovering = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        link: async (source, destination) => {
          await nodeLink(source, destination);
          linked();
          await resumeLink;
        },
        open: nodeOpen,
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    const winner = readRecoverableCredentialMutationIntent(
      recovering,
      () => "dead",
    );
    await linkObserved;
    await expect(
      readRecoverableCredentialMutationIntent(recovering, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await expect(
      inspectCredentialMutation(recovering, () => "dead"),
    ).resolves.toEqual({ state: "reconciliation-required" });
    await expect(
      createCredentialMutationIntent(recovering, {
        recordVersion: 1,
        operation: "retire",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    resume();
    const claimed = await winner;
    await completeCredentialMutationIntent(recovering, claimed);
  });
});

describe("credential recovery claim validation", () => {
  it("blocks credential intent creation behind a configuration writer", async () => {
    const { home } = await homeFixture();
    const crashing = crashingStore(home, "candidate-durable");
    await expect(
      writeConfigurationSnapshot(crashing, {
        expectedGeneration: null,
        candidate: snapshot(0),
        owner,
      }),
    ).rejects.toThrowError(ConfigurationCrashSimulation);
    await expect(
      createCredentialMutationIntent(crashing, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
  });

  it("contains generic storage failures before an intent is durable", async () => {
    const { home } = await homeFixture();
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: (path, flags, mode) =>
          String(path).endsWith("credential.lock")
            ? Promise.reject(new Error("CANARY_SECRET"))
            : nodeOpen(path, flags, mode),
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      createCredentialMutationIntent(store, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });
  });

  it("blocks a credential writer when a recovery gate appears after create", async () => {
    const { home } = await homeFixture();
    let claimReads = 0;
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("credential.recovery.lock") &&
            ++claimReads === 2
          )
            await nodeLink(
              join(home.mutationDirectory, "credential.lock"),
              path,
            );
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      createCredentialMutationIntent(store, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
  });

  it("preserves a substituted credential lock behind a recovery gate", async () => {
    const { home } = await homeFixture();
    let claimReads = 0;
    const lock = join(home.mutationDirectory, "credential.lock");
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("credential.recovery.lock") &&
            ++claimReads === 2
          ) {
            await nodeLink(lock, path);
            const record = JSON.parse(
              await readFileAsync(lock, "utf8"),
            ) as Record<string, unknown>;
            record.operation = "retire";
            await writeFileAsync(lock, `${JSON.stringify(record)}\n`);
          }
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      createCredentialMutationIntent(store, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.contention" });
    await expect(readFileAsync(lock, "utf8")).resolves.toContain("retire");
  });
});

describe("credential recovered claim validation", () => {
  it("rejects substituted and reclassified credential recovery claims", async () => {
    const first = await homeFixture();
    await createCredentialMutationIntent(first.store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    const substituted = createConfigurationStoreForTesting(
      first.home,
      registry,
      {
        fileSystem: {
          link: async (source, destination) => {
            await nodeLink(source, destination);
            const record = JSON.parse(
              await readFileAsync(destination, "utf8"),
            ) as Record<string, unknown>;
            record.operation = "retire";
            await writeFileAsync(destination, `${JSON.stringify(record)}\n`);
          },
          open: nodeOpen,
          rename: nodeRename,
          unlink: nodeUnlink,
        },
      },
    );
    await expect(
      readRecoverableCredentialMutationIntent(substituted, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });

    const second = await homeFixture();
    const intent = await createCredentialMutationIntent(second.store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    let probes = 0;
    await expect(
      readRecoverableCredentialMutationIntent(second.store, () =>
        probes++ === 0 ? "dead" : "unknown",
      ),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });
    await completeCredentialMutationIntent(second.store, intent);
    await expect(
      completeCredentialMutationIntent(second.store, intent),
    ).rejects.toMatchObject({ code: "core.configuration.missing" });
  });

  it("uses native linking and rejects a vanished recovery claim", async () => {
    const first = await homeFixture();
    await createCredentialMutationIntent(first.store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    const fallback = createConfigurationStoreForTesting(first.home, registry, {
      fileSystem: { open: nodeOpen, rename: nodeRename, unlink: nodeUnlink },
    });
    const claimed = await readRecoverableCredentialMutationIntent(
      fallback,
      () => "dead",
    );
    await completeCredentialMutationIntent(fallback, claimed);

    const second = await homeFixture();
    await createCredentialMutationIntent(second.store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    const vanishing = createConfigurationStoreForTesting(
      second.home,
      registry,
      {
        fileSystem: {
          link: async (source, destination) => {
            await nodeLink(source, destination);
            await nodeUnlink(destination);
          },
          open: nodeOpen,
          rename: nodeRename,
          unlink: nodeUnlink,
        },
      },
    );
    await expect(
      readRecoverableCredentialMutationIntent(vanishing, () => "dead"),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });
  });
});

describe("credential recovery claim hostile evidence", () => {
  it("rejects hostile, substituted, and non-dead recovery evidence", async () => {
    const { home, store } = await homeFixture();
    const intent = await createCredentialMutationIntent(store, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    await expect(
      readRecoverableCredentialMutationIntent(store, () => "live"),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-live",
    });
    await expect(
      readRecoverableCredentialMutationIntent(store, () => "unknown"),
    ).rejects.toMatchObject({
      code: "core.configuration.recovery-owner-unknown",
    });
    await expect(
      completeCredentialMutationIntent(store, {
        ...intent,
        reference: createStoredCredentialReference(
          "macos-keychain",
          `credential-reference-v1-${"e".repeat(64)}`,
          `credential-generation-v1-${"d".repeat(64)}`,
        ),
      }),
    ).rejects.toMatchObject({ code: "core.configuration.conflict" });
    const parsed = JSON.parse(
      await readFileAsync(
        join(home.mutationDirectory, "credential.lock"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    await writeFileAsync(
      join(home.mutationDirectory, "credential.lock"),
      `${JSON.stringify({ owner: parsed.owner, ...parsed })}\n`,
    );
    await expect(
      inspectCredentialMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await writeFileAsync(
      join(home.mutationDirectory, "credential.lock"),
      "{}\n",
    );
    await expect(
      inspectCredentialMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
  });
});

describe("credential mutation intent hostile boundaries", () => {
  it("bounds and contains hostile credential intent inputs and storage", async () => {
    const { home, store } = await homeFixture();
    for (const input of [
      null,
      {},
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
      {
        recordVersion: 1,
        owner: {},
        ownership: credentialOwnership,
        reference: credentialReference,
      },
    ])
      await expect(
        createCredentialMutationIntent(store, input as never),
      ).rejects.toMatchObject({ code: "core.configuration.invalid" });

    await mkdirAsync(home.mutationDirectory, { recursive: true });
    const file = join(home.mutationDirectory, "credential.lock");
    for (const value of ["not-json\n", "{}\n ", "x".repeat(4_097)]) {
      await writeFileAsync(file, value);
      await expect(
        inspectCredentialMutation(store, () => "dead"),
      ).resolves.toEqual({ state: "invalid" });
    }
    await rmAsync(file);
    const target = join(home.root, "credential-lock-target");
    await writeFileAsync(target, "{}\n");
    await symlinkAsync(target, file);
    await expect(
      inspectCredentialMutation(store, () => "dead"),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("maps credential intent I/O failures to fixed errors", async () => {
    const { home } = await homeFixture();
    const failing = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: () =>
          Promise.reject(
            Object.assign(new Error("CANARY_SECRET"), { code: "EACCES" }),
          ),
        rename: nodeRename,
        unlink: () => Promise.reject(new Error("CANARY_SECRET")),
      },
    });
    await expect(
      createCredentialMutationIntent(failing, {
        recordVersion: 1,
        operation: "create",
        owner,
        ownership: credentialOwnership,
        reference: credentialReference,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });

    const normal = createConfigurationStore(home, registry);
    const intent = await createCredentialMutationIntent(normal, {
      recordVersion: 1,
      operation: "create",
      owner,
      ownership: credentialOwnership,
      reference: credentialReference,
    });
    const unlinkFailure = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: nodeOpen,
        rename: nodeRename,
        unlink: () => Promise.reject(new Error("CANARY_SECRET")),
      },
    });
    await expect(
      completeCredentialMutationIntent(unlinkFailure, intent),
    ).rejects.toMatchObject({ code: "core.configuration.unavailable" });
  });
});

describe("noninteractive configuration reads", () => {
  it("returns fixed missing, invalid, unsupported, and successful results", async () => {
    const { home, store } = await homeFixture();
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.missing",
    });
    await mkdirAsync(home.root, { recursive: true });
    await writeFileAsync(home.configFile, "not-json");
    await expect(
      readConfigurationForHook(store, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
    const unsupported = parseAgentscopeConfiguration(
      {
        ...document(0),
        destinations: { "@agentscope/destination-future": { version: 9 } },
      },
      registry,
    );
    await writeFileAsync(
      home.configFile,
      serializeAgentscopeConfiguration(unsupported),
    );
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.unsupported",
    });
    await writeFileAsync(home.configFile, snapshotText(0));
    const result = await readConfigurationForHook(store);
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects symlinked, oversized, and unreadable active files", async () => {
    const { home, store } = await homeFixture();
    await mkdirAsync(home.root, { recursive: true });
    const target = join(home.root, "target.json");
    await writeFileAsync(target, snapshotText(0));
    await symlinkAsync(target, home.configFile);
    await expect(
      readConfigurationForHook(store, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.unavailable",
    });
    await rmAsync(home.configFile);
    await writeFileAsync(
      home.configFile,
      "x".repeat(MAXIMUM_CONFIGURATION_FILE_BYTES + 1),
    );
    await expect(
      readConfigurationForHook(store, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
    await chmodAsync(home.configFile, 0o000);
    await expect(readConfigurationForHook(store)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      readConfigurationForHook({ configurationStore: "agentscope-core" }),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
  });
});

describe("configuration byte and lock isolation", () => {
  it("rejects noncanonical or invalid UTF-8 bytes and never backs them up", async () => {
    const { home, store } = await homeFixture();
    await mkdirAsync(home.root, { recursive: true });
    const duplicate = snapshotText(0).replace(
      '"generation":0',
      '"generation":0,"generation":0,"hidden":"CANARY_SECRET"',
    );
    await writeFileAsync(home.configFile, duplicate);
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
    await expect(
      writeConfigurationSnapshot(store, {
        expectedGeneration: 0,
        candidate: snapshot(1),
        owner,
      }),
    ).rejects.toMatchObject({ code: "core.configuration.invalid" });
    await expect(accessAsync(home.configBackupFile)).rejects.toBeDefined();

    await writeFileAsync(home.configFile, `${snapshotText(0)} `);
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });

    await writeFileAsync(home.configFile, Buffer.from([0xc3, 0x28]));
    await expect(
      readConfigurationForHook(store, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
  });

  it("reads a valid snapshot without consulting an active mutation lock", async () => {
    const { home, store } = await homeFixture();
    await writeConfigurationSnapshot(store, {
      expectedGeneration: null,
      candidate: snapshot(0),
      owner,
    });
    await writeFileAsync(
      join(home.mutationDirectory, "config.lock"),
      "hostile-content-that-must-not-reach-the-hook",
    );
    await expect(readConfigurationForHook(store)).resolves.toMatchObject({
      ok: true,
      snapshot: { generation: 0 },
    });
  });

  it("bounds bytes read even when a file grows after its metadata check", async () => {
    const { home } = await homeFixture();
    const fakeHandle = {
      stat: () => Promise.resolve({ isFile: () => true, size: 0 }),
      read: (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x20, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      },
      close: () => Promise.resolve(),
    };
    const store = createConfigurationStoreForTesting(home, registry, {
      fileSystem: {
        open: () => Promise.resolve(fakeHandle),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      } as never,
    });
    await expect(readConfigurationForHook(store)).resolves.toEqual({
      ok: false,
      code: "core.configuration.invalid",
    });
  });
});
