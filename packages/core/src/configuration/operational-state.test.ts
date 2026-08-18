import {
  link as nodeLink,
  mkdir,
  mkdtemp,
  open as nodeOpen,
  rename as nodeRename,
  readFile,
  rm,
  stat,
  symlink,
  unlink as nodeUnlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentscopeHomeResolver,
  ensureAgentscopeHomeLayout,
} from "./home.js";
import {
  createOperationalStateStore,
  createOperationalStateStoreForTesting,
  inspectOperationalState,
  inspectOperationalStateLock,
  OperationalStateError,
  recoverAbandonedOperationalStateLock,
  recordCaptureCheckpoint,
  recordPipelineHealth,
  recordSanitizedDiagnostic,
} from "./operational-state.js";
import { createConfigurationProcessIdentity } from "./transaction.js";

const roots: string[] = [];
const hex = "a".repeat(64);
const connectionId = `destination-connection-v1-${hex}`;
const secondConnectionId = `destination-connection-v1-${"b".repeat(64)}`;
const owner = createConfigurationProcessIdentity(
  111,
  `process-start-v1-${"c".repeat(64)}`,
);
const homeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-operational-"));
  roots.push(root);
  return createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: root },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("operational state", () => {
  it("inspects a missing store without creating machine state", async () => {
    const home = await homeFixture();
    await rm(home.root, { recursive: true });
    const snapshot = await inspectOperationalState(
      createOperationalStateStore(home, owner),
    );

    expect(snapshot).toEqual({
      version: 1,
      nextSequence: 0,
      losses: { diagnostics: 0, health: 0, checkpoints: 0 },
      diagnostics: [],
      health: [],
      checkpoints: [],
    });
    await expect(stat(home.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.losses)).toBe(true);
  });

  it("records only bounded content-free diagnostic, health, and checkpoint data", async () => {
    const home = await homeFixture();
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => 1_000,
      randomId: () => "b".repeat(32),
    });

    await expect(
      recordSanitizedDiagnostic(store, {
        code: "credential-locked",
        severity: "warning",
        configurationGeneration: 2,
        destinationType: "@agentscope/destination-langfuse",
        connectionId,
      }),
    ).resolves.toMatchObject({ recorded: true, code: "recorded" });
    await expect(
      recordPipelineHealth(store, {
        scope: "connection",
        stage: "delivery",
        outcome: "outcome-unknown",
        configurationGeneration: 2,
        policyMode: "strict",
        destinationType: "@agentscope/destination-langfuse",
        connectionId,
        receipt: "outcome-unknown",
      }),
    ).resolves.toMatchObject({ recorded: true, code: "recorded" });
    await expect(
      recordCaptureCheckpoint(store, {
        adapterId: "@agentscope/harness-codex",
        sourceIdentityDigest: hex,
        sourceGeneration: 4,
        acknowledgedExclusivePosition: 19,
        configurationGeneration: 2,
        connectionId,
      }),
    ).resolves.toMatchObject({ recorded: true, code: "recorded" });

    const snapshot = await inspectOperationalState(store);
    expect(snapshot.nextSequence).toBe(3);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.health).toHaveLength(1);
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);
    const stored = await readFile(
      join(home.healthDirectory, "operational-state-v1.json"),
      "utf8",
    );
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("traceId");
    expect(stored.endsWith("\n")).toBe(true);
  });
});

describe("operational state retention", () => {
  it("replaces current health and checkpoint markers deterministically", async () => {
    const home = await homeFixture();
    let now = 1_000;
    let temporary = 0;
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => now,
      randomId: () => (++temporary).toString(16).padStart(32, "0"),
    });
    const hook = (outcome: "completed" | "suppressed") =>
      recordPipelineHealth(store, {
        scope: "hook",
        stage: "redaction",
        outcome,
        configurationGeneration: 1,
        policyMode: "baseline",
        receipt: null,
      });
    await hook("completed");
    now += 1;
    await hook("suppressed");
    for (const selectedConnectionId of [connectionId, secondConnectionId])
      await recordPipelineHealth(store, {
        scope: "connection",
        stage: "delivery",
        outcome: "accepted",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        connectionId: selectedConnectionId,
        receipt: "accepted",
      });
    const checkpoint = (position: number) =>
      recordCaptureCheckpoint(store, {
        adapterId: "@agentscope/harness-codex",
        sourceIdentityDigest: hex,
        sourceGeneration: 1,
        acknowledgedExclusivePosition: position,
        configurationGeneration: 1,
        connectionId,
      });
    await checkpoint(10);
    now += 1;
    await checkpoint(20);

    const snapshot = await inspectOperationalState(store);
    expect(snapshot.health).toHaveLength(3);
    expect(
      snapshot.health.find((entry) => entry.scope === "hook"),
    ).toMatchObject({
      outcome: "suppressed",
    });
    expect(snapshot.checkpoints).toMatchObject([
      { acknowledgedExclusivePosition: 20 },
    ]);
    expect(snapshot.losses).toEqual({
      diagnostics: 0,
      health: 0,
      checkpoints: 0,
    });
  });

  it("evicts expired and over-count entries with exact loss accounting", async () => {
    const home = await homeFixture();
    let now = 1;
    let temporary = 0;
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => now,
      randomId: () => (++temporary).toString(16).padStart(32, "0"),
    });
    for (let index = 0; index < 129; index += 1) {
      now += 1;
      await recordSanitizedDiagnostic(store, {
        code: "capture-failed",
        severity: "warning",
        configurationGeneration: null,
      });
    }
    let snapshot = await inspectOperationalState(store);
    expect(snapshot.diagnostics).toHaveLength(128);
    expect(snapshot.losses.diagnostics).toBe(1);

    now += 7 * 24 * 60 * 60 * 1_000 + 1;
    await recordSanitizedDiagnostic(store, {
      code: "configuration-invalid",
      severity: "error",
      configurationGeneration: null,
    });
    snapshot = await inspectOperationalState(store);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.losses.diagnostics).toBe(129);
  }, 10_000);
});

describe("operational state boundaries", () => {
  it("rejects hostile, inconsistent, and path-shaping input with fixed results", async () => {
    const home = await homeFixture();
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      randomId: () => "../escape",
    });
    const hostile = Object.defineProperty({}, "code", {
      get: () => {
        throw new Error("CANARY_SECRET");
      },
    });

    await expect(
      recordSanitizedDiagnostic(store, hostile as never),
    ).resolves.toEqual({
      recorded: false,
      code: "invalid",
      losses: { diagnostics: 0, health: 0, checkpoints: 0 },
    });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "credential-missing",
        severity: "error",
        configurationGeneration: 1,
        connectionId,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "hook",
        stage: "capture",
        outcome: "suppressed",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        receipt: null,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "hook",
        stage: "capture",
        outcome: "suppressed",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        receipt: null,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "connection",
        stage: "delivery",
        outcome: "accepted",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        connectionId,
        receipt: "rejected",
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "hook",
        stage: "capture",
        outcome: "suppressed",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        connectionId,
        receipt: null,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "not-a-code",
        severity: "warning",
        configurationGeneration: null,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "capture-failed",
        severity: "warning",
        configurationGeneration: null,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
  });
});

describe("operational state relational boundaries", () => {
  it("rejects one-sided destination evidence for diagnostics and health", async () => {
    const home = await homeFixture();
    const store = createOperationalStateStore(home, owner);
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "credential-missing",
        severity: "error",
        configurationGeneration: 1,
        destinationType: "@agentscope/destination-langfuse",
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "connection",
        stage: "delivery",
        outcome: "unavailable",
        configurationGeneration: 1,
        policyMode: "baseline",
        receipt: "unavailable",
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
    await expect(
      recordPipelineHealth(store, {
        scope: "hook",
        stage: "capture",
        outcome: "suppressed",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-langfuse",
        receipt: null,
      } as never),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });
  });
});

describe("operational state stored-byte boundaries", () => {
  it("rejects corrupt, noncanonical, oversized, and symlinked state", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    const file = join(home.healthDirectory, "operational-state-v1.json");
    const store = createOperationalStateStore(home, owner);
    for (const value of ["{}", '{"version":1}\n ', "x".repeat(262_145)]) {
      await writeFile(file, value);
      await expect(inspectOperationalState(store)).rejects.toThrowError(
        OperationalStateError,
      );
    }
    const target = join(home.root, "target");
    await writeFile(target, "{}\n");
    await rm(file);
    await symlink(target, file);
    await expect(inspectOperationalState(store)).rejects.toThrowError(
      OperationalStateError,
    );
  });

  it("serializes concurrent writes in one process", async () => {
    const home = await homeFixture();
    let temporary = 0;
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => 10,
      randomId: () => (++temporary).toString(16).padStart(32, "0"),
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordSanitizedDiagnostic(store, {
          code: "no-route",
          severity: "info",
          configurationGeneration: 1,
        }),
      ),
    );
    expect(results.every((result) => result.recorded)).toBe(true);
    expect((await inspectOperationalState(store)).diagnostics).toHaveLength(8);
  });
});

describe("operational state failures", () => {
  it("returns fixed failures for invalid clocks, sequence exhaustion, and I/O", async () => {
    const home = await homeFixture();
    const invalidClock = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => Number.NaN,
    });
    await expect(
      recordSanitizedDiagnostic(invalidClock, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });

    await ensureAgentscopeHomeLayout(home);
    await writeFile(
      join(home.healthDirectory, "operational-state-v1.json"),
      `${JSON.stringify({
        version: 1,
        nextSequence: Number.MAX_SAFE_INTEGER,
        losses: { diagnostics: 0, health: 0, checkpoints: 0 },
        diagnostics: [],
        health: [],
        checkpoints: [],
      })}\n`,
    );
    await expect(
      recordSanitizedDiagnostic(createOperationalStateStore(home, owner), {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });

    await rm(join(home.healthDirectory, "operational-state-v1.json"));
    const unavailable = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: nodeOpen,
        rename: () => Promise.reject(new Error("CANARY_SECRET")),
        unlink: nodeUnlink,
      },
      randomId: () => "f".repeat(32),
    });
    await expect(
      recordSanitizedDiagnostic(unavailable, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
  });

  it("rejects hostile store construction and a growing state file", async () => {
    const home = await homeFixture();
    expect(() =>
      createOperationalStateStoreForTesting(null as never),
    ).toThrowError(OperationalStateError);
    expect(() =>
      createOperationalStateStoreForTesting({
        home,
        owner,
        extra: true,
      } as never),
    ).toThrowError(OperationalStateError);
    expect(() =>
      createOperationalStateStoreForTesting({ home: {} as never, owner }),
    ).toThrowError(OperationalStateError);
    await expect(
      inspectOperationalState({ operationalStateStore: "agentscope-core" }),
    ).rejects.toThrowError(OperationalStateError);

    const fakeHandle = {
      stat: () => Promise.resolve({ isFile: () => true, size: 0 }),
      read: (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x20, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      },
      close: () => Promise.resolve(),
    };
    const growing = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: () => Promise.resolve(fakeHandle),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      } as never,
    });
    await expect(inspectOperationalState(growing)).rejects.toThrowError(
      OperationalStateError,
    );
  });
});

describe("operational state writer lock", () => {
  it("serializes independent stores with an exclusive cross-process lock", async () => {
    const home = await homeFixture();
    const first = createOperationalStateStoreForTesting({
      home,
      owner,
      randomId: () => "1".repeat(32),
    });
    const second = createOperationalStateStoreForTesting({
      home,
      owner,
      randomId: () => "2".repeat(32),
    });
    const input = {
      code: "no-route" as const,
      severity: "info" as const,
      configurationGeneration: 0,
    };
    const results = await Promise.all([
      recordSanitizedDiagnostic(first, input),
      recordSanitizedDiagnostic(second, input),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([
      "recorded",
      "unavailable",
    ]);
    expect((await inspectOperationalState(first)).diagnostics).toHaveLength(1);
  });

  it("inspects and repairs only a dead operational writer lock", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    const lock = join(home.healthDirectory, "operational-state.lock");
    await writeFile(
      lock,
      `${JSON.stringify({
        version: 1,
        owner,
        token: "3".repeat(32),
      })}\n`,
    );
    const store = createOperationalStateStore(home, owner);
    await expect(
      inspectOperationalStateLock(store, () => "live"),
    ).resolves.toEqual({ state: "active" });
    await expect(
      inspectOperationalStateLock(store, () => "unknown"),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "recoverable" });
    await expect(
      recoverAbandonedOperationalStateLock(store, () => "live"),
    ).rejects.toThrowError(OperationalStateError);
    await expect(
      recoverAbandonedOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ recovered: true });
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "clean" });
  });
});

describe("operational state hostile writer locks", () => {
  it("contains malformed locks, hostile owner probes, and invalid writer identities", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    const lock = join(home.healthDirectory, "operational-state.lock");
    const store = createOperationalStateStore(home, owner);
    await writeFile(lock, "{}\n");
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await writeFile(
      lock,
      `${JSON.stringify({ version: 1, owner, token: "4".repeat(32) })}\n`,
    );
    await expect(
      inspectOperationalStateLock(store, (() =>
        Promise.reject(new Error("CANARY_SECRET"))) as never),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      inspectOperationalStateLock(store, (() =>
        Promise.resolve("dead")) as never),
    ).resolves.toEqual({ state: "owner-unknown" });
    await expect(
      inspectOperationalStateLock(store, () => {
        throw new Error("CANARY_SECRET");
      }),
    ).resolves.toEqual({ state: "owner-unknown" });
    await rm(lock);
    await expect(
      recoverAbandonedOperationalStateLock(store, () => "dead"),
    ).rejects.toThrowError(OperationalStateError);

    const invalidIdentity = createOperationalStateStoreForTesting({
      home,
      owner,
      randomId: () => "not-an-identity",
    });
    await expect(
      recordSanitizedDiagnostic(invalidIdentity, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });

    let identityCall = 0;
    const invalidTemporary = createOperationalStateStoreForTesting({
      home,
      owner,
      randomId: () =>
        identityCall++ === 0 ? "5".repeat(32) : "not-an-identity",
    });
    await expect(
      recordSanitizedDiagnostic(invalidTemporary, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "invalid" });

    const failedRelease = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: nodeOpen,
        rename: nodeRename,
        unlink: () => Promise.reject(new Error("CANARY_SECRET")),
      },
      randomId: (() => {
        let value = 5;
        return () => (++value).toString(16).padStart(32, "0");
      })(),
    });
    await expect(
      recordSanitizedDiagnostic(failedRelease, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
  });
});

describe("operational state writer lock claims", () => {
  it("rejects a substituted writer lock before replacing shared state", async () => {
    const home = await homeFixture();
    const lock = join(home.healthDirectory, "operational-state.lock");
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      now: () => {
        writeFileSync(
          lock,
          `${JSON.stringify({ version: 1, owner, token: "9".repeat(32) })}\n`,
        );
        return 1;
      },
      randomId: () => "8".repeat(32),
    });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
  });

  it("abandons its lock when a recovery claim appears after create", async () => {
    const home = await homeFixture();
    let claimReads = 0;
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("operational-state.recovery.lock") &&
            ++claimReads === 2
          )
            await nodeLink(
              join(home.healthDirectory, "operational-state.lock"),
              path,
            );
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
      randomId: () => "c".repeat(32),
    });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
  });

  it("preserves a substituted lock when a recovery gate appears", async () => {
    const home = await homeFixture();
    let claimReads = 0;
    const lock = join(home.healthDirectory, "operational-state.lock");
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: async (path, flags, mode) => {
          if (
            String(path).endsWith("operational-state.recovery.lock") &&
            ++claimReads === 2
          ) {
            await nodeLink(lock, path);
            await writeFile(
              lock,
              `${JSON.stringify({ version: 1, owner, token: "d".repeat(32) })}\n`,
            );
          }
          return nodeOpen(path, flags, mode);
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
      randomId: () => "c".repeat(32),
    });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
    await expect(readFile(lock, "utf8")).resolves.toContain("dddddddd");
  });
});

describe("operational state recovery claim concurrency", () => {
  it("uses the native hard-link fallback for injected file systems", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    await writeFile(
      join(home.healthDirectory, "operational-state.lock"),
      `${JSON.stringify({ version: 1, owner, token: "e".repeat(32) })}\n`,
    );
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: { open: nodeOpen, rename: nodeRename, unlink: nodeUnlink },
    });
    await expect(
      recoverAbandonedOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ recovered: true });
  });

  it("allows one lock recovery winner and blocks a replacement writer", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    await writeFile(
      join(home.healthDirectory, "operational-state.lock"),
      `${JSON.stringify({ version: 1, owner, token: "a".repeat(32) })}\n`,
    );
    let linked!: () => void;
    let resume!: () => void;
    const linkObserved = new Promise<void>((resolve) => {
      linked = resolve;
    });
    const resumeLink = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = createOperationalStateStoreForTesting({
      home,
      owner,
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
      randomId: () => "b".repeat(32),
    });
    const winner = recoverAbandonedOperationalStateLock(store, () => "dead");
    await linkObserved;
    await expect(
      recoverAbandonedOperationalStateLock(store, () => "dead"),
    ).rejects.toThrowError("core.operational-state.unavailable");
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "reconciliation-required" });
    await expect(
      recordSanitizedDiagnostic(store, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
    resume();
    await expect(winner).resolves.toEqual({ recovered: true });
  });

  it("contains recovery claim failures and owner changes", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    const lock = join(home.healthDirectory, "operational-state.lock");
    const record = { version: 1 as const, owner, token: "7".repeat(32) };
    await writeFile(lock, `${JSON.stringify(record)}\n`);
    const renameFailure = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        link: () => Promise.reject(new Error("CANARY_SECRET")),
        open: nodeOpen,
        rename: nodeRename,
        unlink: nodeUnlink,
      },
      randomId: () => "6".repeat(32),
    });
    await expect(
      recoverAbandonedOperationalStateLock(renameFailure, () => "dead"),
    ).rejects.toThrowError("core.operational-state.unavailable");

    let probes = 0;
    const changingOwner = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        link: nodeLink,
        open: nodeOpen,
        rename: nodeRename,
        unlink: nodeUnlink,
      },
      randomId: () => "5".repeat(32),
    });
    await expect(
      recoverAbandonedOperationalStateLock(changingOwner, () =>
        probes++ === 0 ? "dead" : "unknown",
      ),
    ).rejects.toThrowError("core.operational-state.unavailable");
  });
});

describe("operational state malformed writer locks", () => {
  it("rejects oversized, non-file, and symlinked lock evidence", async () => {
    const home = await homeFixture();
    await ensureAgentscopeHomeLayout(home);
    const lock = join(home.healthDirectory, "operational-state.lock");
    const store = createOperationalStateStore(home, owner);
    await writeFile(lock, "x".repeat(1_025));
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await rm(lock);
    await mkdir(lock);
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
    await rm(lock, { recursive: true });
    const target = join(home.root, "lock-target");
    await writeFile(target, "{}\n");
    await symlink(target, lock);
    await expect(
      inspectOperationalStateLock(store, () => "dead"),
    ).resolves.toEqual({ state: "unavailable" });

    const growingHandle = {
      stat: () => Promise.resolve({ isFile: () => true, size: 0 }),
      read: (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x20, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      },
      close: () => Promise.resolve(),
    };
    const growing = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: () => Promise.resolve(growingHandle),
        rename: nodeRename,
        unlink: nodeUnlink,
      } as never,
    });
    await expect(
      inspectOperationalStateLock(growing, () => "dead"),
    ).resolves.toEqual({ state: "invalid" });
  });
});

describe("operational state writer lock substitution", () => {
  it("rejects lock substitution and partial lock writes", async () => {
    const home = await homeFixture();
    const substituted = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: nodeOpen,
        rename: async (source, destination) => {
          await nodeRename(source, destination);
          await writeFile(
            join(home.healthDirectory, "operational-state.lock"),
            `${JSON.stringify({
              version: 1,
              owner,
              token: "a".repeat(32),
            })}\n`,
          );
        },
        unlink: nodeUnlink,
      },
      randomId: (() => {
        let value = 10;
        return () => (++value).toString(16).padStart(32, "0");
      })(),
    });
    await expect(
      recordSanitizedDiagnostic(substituted, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });

    await rm(join(home.healthDirectory, "operational-state.lock"));
    let lockHandleOpened = false;
    const partial = createOperationalStateStoreForTesting({
      home,
      owner,
      fileSystem: {
        open: async (...arguments_: Parameters<typeof nodeOpen>) => {
          const handle = await nodeOpen(...arguments_);
          if (
            !lockHandleOpened &&
            String(arguments_[0]).endsWith("operational-state.lock")
          ) {
            lockHandleOpened = true;
            return Object.assign(handle, {
              writeFile: () => Promise.reject(new Error("CANARY_SECRET")),
            });
          }
          return handle;
        },
        rename: nodeRename,
        unlink: nodeUnlink,
      },
    });
    await expect(
      recordSanitizedDiagnostic(partial, {
        code: "no-route",
        severity: "info",
        configurationGeneration: 0,
      }),
    ).resolves.toMatchObject({ recorded: false, code: "unavailable" });
  });
});
