import { describe, expect, it } from "vitest";

import {
  acquireLocalSqliteExclusiveFence,
  acquireLocalSqliteSharedLease,
  amendLocalSqliteLeaseWithChild,
  decodeLocalSqliteFenceRecord,
  decodeLocalSqliteLeaseRecord,
  encodeLocalSqliteFenceRecord,
  encodeLocalSqliteLeaseRecord,
  inspectLocalSqliteDeadLeaseRecoveryPlan,
  inspectLocalSqliteLifecycleInventory,
  LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS,
  parseLocalSqliteFenceRecord,
  parseLocalSqliteLeaseRecord,
  recoverDeadLocalSqliteLease,
  releaseLocalSqliteExclusiveFence,
  releaseLocalSqliteSharedLease,
  type LocalSqliteLifecycleGatePort,
} from "./fence.js";

const fingerprint = `sha256-${"a".repeat(64)}`;
const leaseId = "11111111111111111111111111111111";
const secondLeaseId = "77777777777777777777777777777777";
const transactionId = "22222222222222222222222222222222";
const childNonce = "33333333333333333333333333333333";
const parentStart = "44444444444444444444444444444444";
const secondParentStart = "88888888888888888888888888888888";
const childStart = "55555555555555555555555555555555";
const recoveryStart = "66666666666666666666666666666666";

const sharedRequest = () => ({
  leaseId,
  lifecycleFingerprint: fingerprint,
  lifecycleGeneration: 1,
  parent: { pid: 101, startIdentity: parentStart },
});
const leaseRecord = () => ({ ...sharedRequest(), child: null });

const fenceRequest = () => ({
  transactionId,
  lifecycleFingerprint: fingerprint,
  lifecycleGeneration: 1,
  purpose: "lifecycle" as const,
});
const recoveryPlanRequest = () => ({
  transactionId,
  lifecycleFingerprint: fingerprint,
  lifecycleGeneration: 1,
  recoveryOwner: { pid: 303, startIdentity: recoveryStart },
});

type Stored = { content: string; physicalIdentity: string };
type ReadArtifactInput = Parameters<
  LocalSqliteLifecycleGatePort["readArtifact"]
>[0];
type CreateLeaseInput = Parameters<
  LocalSqliteLifecycleGatePort["createLeaseDurably"]
>[0];
type ReplaceLeaseInput = Parameters<
  LocalSqliteLifecycleGatePort["replaceLeaseDurably"]
>[0];
type RemoveArtifactInput = Parameters<
  LocalSqliteLifecycleGatePort["removeArtifactIfIdentity"]
>[0];
type CreateLeaseCleanupClaimInput = Parameters<
  LocalSqliteLifecycleGatePort["createLeaseCleanupClaim"]
>[0];

// eslint-disable-next-line max-lines-per-function -- the in-memory filesystem keeps every mutation boundary observable in one fixture.
const createMemoryPort = () => {
  const artifacts = new Map<string, Stored>();
  const ownerStates = new Map<string, "live" | "dead" | "indeterminate">();
  let identity = 0;
  let fenceReads = 0;
  let publishFenceOnSecondRead = false;
  let recoveryLockToken: Readonly<Record<string, never>> | undefined;
  const nextIdentity = () => `dev1:ino${(identity += 1)}`;
  const readArtifact: LocalSqliteLifecycleGatePort["readArtifact"] = (
    input,
  ) => {
    if (input.filename === "exclusive-fence-v1") {
      fenceReads += 1;
      if (publishFenceOnSecondRead && fenceReads === 2) {
        const racedFence = parseLocalSqliteFenceRecord(fenceRequest());
        if (racedFence === undefined) throw new Error("fence fixture");
        artifacts.set(input.filename, {
          content: encodeLocalSqliteFenceRecord(racedFence)!,
          physicalIdentity: nextIdentity(),
        });
      }
    }
    const artifact = artifacts.get(input.filename);
    return artifact === undefined
      ? { state: "absent" }
      : { state: "present", ...artifact };
  };
  const create = (filename: string, content: string) => {
    if (artifacts.has(filename)) return { state: "exists" };
    const physicalIdentity = nextIdentity();
    artifacts.set(filename, { content, physicalIdentity });
    return { state: "created", physicalIdentity };
  };
  const port: LocalSqliteLifecycleGatePort = {
    acquireRecoveryFenceLock: ({ filename, physicalIdentity }) => {
      const fence = artifacts.get(filename);
      if (fence?.physicalIdentity !== physicalIdentity)
        return { state: "mismatch" };
      if (recoveryLockToken !== undefined) return { state: "busy" };
      recoveryLockToken = Object.freeze({});
      return { state: "acquired", token: recoveryLockToken };
    },
    assertRecoveryFenceLock: ({ filename, physicalIdentity, token }) => ({
      state:
        recoveryLockToken === token &&
        artifacts.get(filename)?.physicalIdentity === physicalIdentity
          ? "held"
          : "not-held",
    }),
    classifyOwner: ({ owner }) => ({
      state: ownerStates.get(owner.startIdentity) ?? "live",
    }),
    createFenceDurably: ({ filename, content }) => create(filename, content),
    createLeaseDurably: ({ filename, content }) => create(filename, content),
    createLeaseCleanupClaim: ({
      cleanupClaimName,
      leaseName,
      leasePhysicalIdentity,
    }) => {
      const lease = artifacts.get(leaseName);
      if (
        lease === undefined ||
        lease.physicalIdentity !== leasePhysicalIdentity ||
        artifacts.has(cleanupClaimName)
      )
        return { state: "mismatch" };
      artifacts.set(cleanupClaimName, lease);
      return { state: "created", physicalIdentity: lease.physicalIdentity };
    },
    listLifecycle: () => ({
      entries: [...artifacts.entries()].map(([name, artifact]) => ({
        name,
        bytes: artifact.content.length,
        physicalIdentity: artifact.physicalIdentity,
      })),
    }),
    readArtifact,
    removeArtifactIfIdentity: ({ filename, physicalIdentity }) => {
      const artifact = artifacts.get(filename);
      if (artifact === undefined) return { state: "absent" };
      if (artifact.physicalIdentity !== physicalIdentity)
        return { state: "mismatch" };
      artifacts.delete(filename);
      return { state: "removed" };
    },
    releaseRecoveryFenceLock: ({ token }) => {
      if (recoveryLockToken !== token) return { state: "not-held" };
      recoveryLockToken = undefined;
      return { state: "released" };
    },
    replaceLeaseDurably: ({ filename, physicalIdentity, content }) => {
      const artifact = artifacts.get(filename);
      if (artifact?.physicalIdentity !== physicalIdentity)
        return { state: "mismatch" };
      const replacementIdentity = nextIdentity();
      artifacts.set(filename, {
        content,
        physicalIdentity: replacementIdentity,
      });
      return { state: "replaced", physicalIdentity: replacementIdentity };
    },
  };
  return {
    artifacts,
    ownerStates,
    port,
    recoveryRequest: () => {
      const leaseIds = new Set<string>();
      for (const name of artifacts.keys()) {
        const match = /^(?:lease|lease-cleanup)-([a-f0-9]{32})\.json$/u.exec(
          name,
        );
        if (match?.[1] !== undefined) leaseIds.add(match[1]);
      }
      const deadLeaseVector = [...leaseIds].sort().map((id) => {
        const lease = artifacts.get(`lease-${id}.json`);
        const claim = artifacts.get(`lease-cleanup-${id}.json`);
        const stored = lease ?? claim;
        if (stored === undefined) throw new Error("recovery fixture");
        const record = decodeLocalSqliteLeaseRecord(stored.content);
        if (record === undefined) throw new Error("recovery record fixture");
        return {
          originalState:
            lease !== undefined && claim !== undefined
              ? ("lease+cleanup-claim" as const)
              : lease !== undefined
                ? ("lease-only" as const)
                : ("cleanup-claim-only" as const),
          physicalIdentity: stored.physicalIdentity,
          record,
        };
      });
      return {
        transactionId,
        lifecycleFingerprint: fingerprint,
        lifecycleGeneration: 1,
        purpose: "recovery" as const,
        recoveryOwner: { pid: 303, startIdentity: recoveryStart },
        deadLeaseVector,
      };
    },
    dropRecoveryLock: () => {
      recoveryLockToken = undefined;
    },
    setFenceRace: () => {
      publishFenceOnSecondRead = true;
    },
  };
};

const createDeadLeaseRecovery = async () => {
  const memory = createMemoryPort();
  const shared = await acquireLocalSqliteSharedLease(
    memory.port,
    sharedRequest(),
  );
  if (!shared.ok) throw new Error("expected shared authority");
  memory.ownerStates.set(parentStart, "dead");
  const plan = await inspectLocalSqliteDeadLeaseRecoveryPlan(
    memory.port,
    recoveryPlanRequest(),
  );
  if (!plan.ok) throw new Error("expected recovery plan");
  const recovery = await acquireLocalSqliteExclusiveFence(
    memory.port,
    plan.value,
  );
  if (!recovery.ok) throw new Error("expected recovery authority");
  return { memory, recovery };
};

describe("Local SQLite lifecycle gate", () => {
  it("publishes, verifies, rereads, amends, and releases one shared lease", async () => {
    const memory = createMemoryPort();
    const acquired = await acquireLocalSqliteSharedLease(
      memory.port,
      sharedRequest(),
    );
    expect(acquired).toMatchObject({ ok: true });
    if (!acquired.ok) throw new Error("expected shared authority");
    expect(memory.artifacts.get(acquired.value.filename)?.content).toHaveLength(
      256,
    );

    const amended = await amendLocalSqliteLeaseWithChild(
      memory.port,
      acquired.value,
      { nonce: childNonce, pid: 202, startIdentity: childStart },
    );
    expect(amended).toMatchObject({
      ok: true,
      value: { record: { child: { nonce: childNonce } } },
    });
    if (!amended.ok) throw new Error("expected amended authority");
    expect(
      await releaseLocalSqliteSharedLease(memory.port, amended.value),
    ).toEqual({ ok: true, state: "released" });
    expect(memory.artifacts.size).toBe(0);
  });

  it("removes only its exact lease and refuses to open when a fence wins", async () => {
    const memory = createMemoryPort();
    memory.setFenceRace();
    expect(
      await acquireLocalSqliteSharedLease(memory.port, sharedRequest()),
    ).toEqual({ ok: false, state: "busy" });
    expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(false);
    expect(memory.artifacts.has("exclusive-fence-v1")).toBe(true);
  });

  it("publishes the exclusive fence before inventory and blocks live leases", async () => {
    const memory = createMemoryPort();
    const shared = await acquireLocalSqliteSharedLease(
      memory.port,
      sharedRequest(),
    );
    expect(shared.ok).toBe(true);
    expect(
      await acquireLocalSqliteExclusiveFence(memory.port, fenceRequest()),
    ).toEqual({ ok: false, state: "busy" });
    expect(memory.artifacts.has("exclusive-fence-v1")).toBe(false);
    expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(true);
  });

  it("acquires and releases an exclusive fence when no lease exists", async () => {
    const memory = createMemoryPort();
    const acquired = await acquireLocalSqliteExclusiveFence(
      memory.port,
      fenceRequest(),
    );
    expect(acquired).toMatchObject({
      ok: true,
      value: { state: "exclusive", deadLeaseNames: [] },
    });
    if (!acquired.ok) throw new Error("expected exclusive authority");
    expect(
      await releaseLocalSqliteExclusiveFence(memory.port, acquired.value),
    ).toEqual({ ok: true, state: "released" });
  });

  it("requires recovery purpose and an exact hard-link claim for dead leases", async () => {
    const memory = createMemoryPort();
    const shared = await acquireLocalSqliteSharedLease(
      memory.port,
      sharedRequest(),
    );
    expect(shared.ok).toBe(true);
    memory.ownerStates.set(parentStart, "dead");
    expect(
      await acquireLocalSqliteExclusiveFence(memory.port, fenceRequest()),
    ).toEqual({ ok: false, state: "recovery-required" });
    const plan = await inspectLocalSqliteDeadLeaseRecoveryPlan(
      memory.port,
      recoveryPlanRequest(),
    );
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) throw new Error("expected recovery plan");
    const recovery = await acquireLocalSqliteExclusiveFence(
      memory.port,
      plan.value,
    );
    expect(recovery).toMatchObject({
      ok: true,
      value: {
        state: "exclusive-recovery",
        deadLeaseNames: [`lease-${leaseId}.json`],
      },
    });
    if (!recovery.ok) throw new Error("expected recovery authority");
    expect(
      await recoverDeadLocalSqliteLease(
        memory.port,
        recovery.value,
        `lease-${leaseId}.json`,
      ),
    ).toEqual({ ok: true, state: "recovered" });
    expect(
      await releaseLocalSqliteExclusiveFence(memory.port, recovery.value),
    ).toEqual({ ok: true, state: "released" });
    expect(memory.artifacts.size).toBe(0);
  });
});

describe("Local SQLite canonical dead-lease recovery vector", () => {
  const prepareTwoDeadLeases = async () => {
    const memory = createMemoryPort();
    for (const request of [
      sharedRequest(),
      {
        ...sharedRequest(),
        leaseId: secondLeaseId,
        parent: { pid: 404, startIdentity: secondParentStart },
      },
    ]) {
      const acquired = await acquireLocalSqliteSharedLease(
        memory.port,
        request,
      );
      if (!acquired.ok) throw new Error("expected shared lease fixture");
    }
    memory.ownerStates.set(parentStart, "dead");
    memory.ownerStates.set(secondParentStart, "dead");
    const plan = await inspectLocalSqliteDeadLeaseRecoveryPlan(
      memory.port,
      recoveryPlanRequest(),
    );
    if (!plan.ok) throw new Error("expected recovery plan fixture");
    const recovery = await acquireLocalSqliteExclusiveFence(
      memory.port,
      plan.value,
    );
    if (!recovery.ok) throw new Error("expected recovery fence fixture");
    return { memory, plan, recovery };
  };

  it("drains only in canonical order and resumes the exact suffix", async () => {
    const { memory, plan, recovery } = await prepareTwoDeadLeases();
    expect(
      plan.value.deadLeaseVector.map((entry) => entry.record.leaseId),
    ).toEqual([leaseId, secondLeaseId]);
    expect(
      await recoverDeadLocalSqliteLease(
        memory.port,
        recovery.value,
        `lease-${secondLeaseId}.json`,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await recoverDeadLocalSqliteLease(
        memory.port,
        recovery.value,
        `lease-${leaseId}.json`,
      ),
    ).toEqual({ ok: true, state: "recovered" });
    expect(
      await releaseLocalSqliteExclusiveFence(memory.port, recovery.value),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    memory.dropRecoveryLock();
    memory.ownerStates.set(recoveryStart, "dead");
    const resumed = await acquireLocalSqliteExclusiveFence(
      memory.port,
      plan.value,
    );
    expect(resumed).toMatchObject({ ok: true });
    if (!resumed.ok) throw new Error("expected resumed recovery");
    expect(
      await recoverDeadLocalSqliteLease(
        memory.port,
        resumed.value,
        `lease-${secondLeaseId}.json`,
      ),
    ).toEqual({ ok: true, state: "recovered" });
    expect(
      await releaseLocalSqliteExclusiveFence(memory.port, resumed.value),
    ).toEqual({ ok: true, state: "released" });
  });

  it("rejects a non-prefix absence and admits a same-inode monotonic first survivor", async () => {
    const gap = await prepareTwoDeadLeases();
    const second = gap.memory.artifacts.get(`lease-${secondLeaseId}.json`)!;
    gap.memory.artifacts.delete(`lease-${secondLeaseId}.json`);
    gap.memory.dropRecoveryLock();
    gap.memory.ownerStates.set(recoveryStart, "dead");
    expect(
      await acquireLocalSqliteExclusiveFence(gap.memory.port, gap.plan.value),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    gap.memory.artifacts.set(`lease-${secondLeaseId}.json`, second);

    const advanced = await prepareTwoDeadLeases();
    const first = advanced.memory.artifacts.get(`lease-${leaseId}.json`)!;
    expect(
      advanced.memory.port.createLeaseCleanupClaim({
        cleanupClaimName: `lease-cleanup-${leaseId}.json`,
        leaseName: `lease-${leaseId}.json`,
        leasePhysicalIdentity: first.physicalIdentity,
      }),
    ).toMatchObject({ state: "created" });
    advanced.memory.dropRecoveryLock();
    advanced.memory.ownerStates.set(recoveryStart, "dead");
    const resumed = await acquireLocalSqliteExclusiveFence(
      advanced.memory.port,
      advanced.plan.value,
    );
    expect(resumed).toMatchObject({ ok: true });
  });
});

describe("Local SQLite child-amend fence race", () => {
  it("removes its amended lease or requires reconciliation", async () => {
    for (const cleanupFails of [false, true]) {
      const memory = createMemoryPort();
      const shared = await acquireLocalSqliteSharedLease(
        memory.port,
        sharedRequest(),
      );
      if (!shared.ok) throw new Error("expected shared authority");
      const read = memory.port.readArtifact;
      let published = false;
      const result = await amendLocalSqliteLeaseWithChild(
        {
          ...memory.port,
          readArtifact: (input: ReadArtifactInput) => {
            if (input.filename === "exclusive-fence-v1" && !published) {
              published = true;
              const record = parseLocalSqliteFenceRecord(fenceRequest());
              if (record === undefined) throw new Error("fence fixture");
              memory.artifacts.set(input.filename, {
                content: encodeLocalSqliteFenceRecord(record)!,
                physicalIdentity: "dev:racing-fence",
              });
            }
            return read(input);
          },
          ...(cleanupFails
            ? { removeArtifactIfIdentity: () => ({ state: "mismatch" }) }
            : {}),
        },
        shared.value,
        { nonce: childNonce, pid: 202, startIdentity: childStart },
      );
      expect(result).toEqual({
        ok: false,
        state: cleanupFails ? "reconciliation-required" : "busy",
      });
      expect(memory.artifacts.has("exclusive-fence-v1")).toBe(true);
      expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(cleanupFails);
    }
  });

  it("contains missing and malformed final fence reads", async () => {
    for (const finalFence of [
      undefined,
      {
        state: "present",
        physicalIdentity: "dev:malformed-fence",
        content: "malformed".padEnd(256, " "),
      },
    ]) {
      const memory = createMemoryPort();
      const shared = await acquireLocalSqliteSharedLease(
        memory.port,
        sharedRequest(),
      );
      if (!shared.ok) throw new Error("expected shared authority");
      const read = memory.port.readArtifact;
      expect(
        await amendLocalSqliteLeaseWithChild(
          {
            ...memory.port,
            readArtifact: (input: ReadArtifactInput) =>
              input.filename === "exclusive-fence-v1"
                ? finalFence
                : read(input),
          },
          shared.value,
          { nonce: childNonce, pid: 202, startIdentity: childStart },
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
      expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(false);
    }
  });
});

describe("Local SQLite final inventory admission", () => {
  it("requires its exact new lease in the final inventory", async () => {
    const memory = createMemoryPort();
    const list = memory.port.listLifecycle;
    const result = await acquireLocalSqliteSharedLease(
      {
        ...memory.port,
        listLifecycle: () =>
          memory.artifacts.has(`lease-${leaseId}.json`)
            ? { entries: [] }
            : list(),
      },
      sharedRequest(),
    );
    expect(result).toEqual({
      ok: false,
      state: "reconciliation-required",
    });
    expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(false);
  });

  it("cleans its lease when an intent or claim races initial admission", async () => {
    for (const blocker of ["intent", "claim"] as const) {
      for (const cleanupFails of [false, true]) {
        const memory = createMemoryPort();
        const create = memory.port.createLeaseDurably;
        const result = await acquireLocalSqliteSharedLease(
          {
            ...memory.port,
            createLeaseDurably: (input: CreateLeaseInput) => {
              const created = create(input);
              const lease = memory.artifacts.get(input.filename);
              if (lease === undefined) throw new Error("lease fixture");
              memory.artifacts.set(
                blocker === "intent"
                  ? "intent-v1.json"
                  : `lease-cleanup-${leaseId}.json`,
                blocker === "intent"
                  ? { content: "intent", physicalIdentity: "dev:intent" }
                  : lease,
              );
              return created;
            },
            ...(cleanupFails
              ? { removeArtifactIfIdentity: () => ({ state: "mismatch" }) }
              : {}),
          },
          sharedRequest(),
        );
        expect(result).toEqual({
          ok: false,
          state: "reconciliation-required",
        });
        expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(
          cleanupFails,
        );
      }
    }
  });

  it("cleans its replacement when an intent races child admission", async () => {
    for (const cleanupFails of [false, true]) {
      const memory = createMemoryPort();
      const shared = await acquireLocalSqliteSharedLease(
        memory.port,
        sharedRequest(),
      );
      if (!shared.ok) throw new Error("expected shared authority");
      const replace = memory.port.replaceLeaseDurably;
      const result = await amendLocalSqliteLeaseWithChild(
        {
          ...memory.port,
          replaceLeaseDurably: (input: ReplaceLeaseInput) => {
            const replaced = replace(input);
            memory.artifacts.set("intent-v1.json", {
              content: "intent",
              physicalIdentity: "dev:intent",
            });
            return replaced;
          },
          ...(cleanupFails
            ? { removeArtifactIfIdentity: () => ({ state: "mismatch" }) }
            : {}),
        },
        shared.value,
        { nonce: childNonce, pid: 202, startIdentity: childStart },
      );
      expect(result).toEqual({
        ok: false,
        state: "reconciliation-required",
      });
      expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(cleanupFails);
    }
  });
});

describe("Local SQLite lifecycle gate containment", () => {
  it("treats a live or indeterminate child as blocking even when parent is dead", async () => {
    const memory = createMemoryPort();
    const shared = await acquireLocalSqliteSharedLease(
      memory.port,
      sharedRequest(),
    );
    if (!shared.ok) throw new Error("expected shared authority");
    const amended = await amendLocalSqliteLeaseWithChild(
      memory.port,
      shared.value,
      { nonce: childNonce, pid: 202, startIdentity: childStart },
    );
    expect(amended.ok).toBe(true);
    memory.ownerStates.set(parentStart, "dead");
    memory.ownerStates.set(childStart, "indeterminate");
    expect(
      await acquireLocalSqliteExclusiveFence(
        memory.port,
        memory.recoveryRequest(),
      ),
    ).toEqual({ ok: false, state: "busy" });
  });

  it("reports bounded inventory without creating a lease or fence", async () => {
    const memory = createMemoryPort();
    expect(await inspectLocalSqliteLifecycleInventory(memory.port)).toEqual({
      ok: true,
      state: "clean",
      entries: 0,
      leases: 0,
      bytes: 0,
      fence: "absent",
    });
    expect(memory.artifacts.size).toBe(0);
  });

  it("rejects malformed, oversized, duplicate, and over-count inventory", async () => {
    const invalidInventories = [
      { entries: [{ name: "unknown", bytes: 1, physicalIdentity: "dev:1" }] },
      {
        entries: [
          {
            name: `lease-${leaseId}.json`,
            bytes: 255,
            physicalIdentity: "dev:1",
          },
        ],
      },
      {
        entries: Array.from({ length: 65 }, (_, index) => ({
          name: `lease-${(index + 1).toString(16).padStart(32, "0")}.json`,
          bytes: 256,
          physicalIdentity: `dev:${index}`,
        })),
      },
      {
        entries: [
          { name: "intent-v1.json", bytes: 40_000, physicalIdentity: "dev:1" },
          {
            name: "ownership-receipt-v1.json",
            bytes: 40_000,
            physicalIdentity: "dev:2",
          },
        ],
      },
      {
        entries: [
          {
            name: "exclusive-fence-v1",
            bytes: 255,
            physicalIdentity: "dev:1",
          },
        ],
      },
      {
        entries: ["7", "8"].map((digit) => ({
          name: `lease-cleanup-${digit.repeat(32)}.json`,
          bytes: 256,
          physicalIdentity: `dev:${digit}`,
        })),
      },
    ];
    for (const inventory of invalidInventories) {
      const memory = createMemoryPort();
      const port = { ...memory.port, listLifecycle: () => inventory };
      expect(await inspectLocalSqliteLifecycleInventory(port)).toEqual({
        ok: false,
        state: "reconciliation-required",
      });
    }
  });
});

describe("Local SQLite lifecycle hostile-input containment", () => {
  it("contains hostile callback DTOs and never coerces caller values", async () => {
    let coercions = 0;
    const hostile = {
      toString: () => {
        coercions += 1;
        return "live";
      },
    };
    const memory = createMemoryPort();
    const port = {
      ...memory.port,
      classifyOwner: () => ({ state: hostile }),
    };
    const shared = await acquireLocalSqliteSharedLease(port, sharedRequest());
    expect(shared.ok).toBe(true);
    expect(
      await acquireLocalSqliteExclusiveFence(port, memory.recoveryRequest()),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(coercions).toBe(0);

    const proxy = new Proxy(memory.port, {
      getPrototypeOf: () => {
        throw new Error("CANARY");
      },
    });
    expect(await acquireLocalSqliteSharedLease(proxy, sharedRequest())).toEqual(
      { ok: false, state: "unavailable" },
    );

    expect(
      await acquireLocalSqliteSharedLease(
        {
          ...memory.port,
          readArtifact: () => Promise.reject(new Error("CANARY")),
        },
        sharedRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
  });

  it("rejects hostile and non-exact inventory arrays without invoking accessors", async () => {
    let calls = 0;
    const accessor: unknown[] = [{}];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        calls += 1;
        return {};
      },
    });
    const extra = [] as unknown[] & { extra?: boolean };
    extra.extra = true;
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    for (const entries of [
      Array.from({ length: 129 }, () => ({})),
      extra,
      accessor,
      proxy,
    ]) {
      const memory = createMemoryPort();
      expect(
        await inspectLocalSqliteLifecycleInventory({
          ...memory.port,
          listLifecycle: () => ({ entries }),
        }),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }
    expect(calls).toBe(0);
  });

  it("pins the manifest-owned gate constants", () => {
    expect(LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS).toEqual({
      exclusiveFenceName: "exclusive-fence-v1",
      leaseRecordBytes: 256,
      maximumDirectoryEntries: 192,
      maximumFenceRecordBytes: 32_768,
      maximumInspectionBytes: 98_304,
      maximumLeases: 64,
    });
  });
});

describe("Local SQLite shared gate failure containment", () => {
  it("fails closed across shared-acquisition callback and verification ambiguity", async () => {
    const cases: readonly [
      Partial<LocalSqliteLifecycleGatePort>,
      "busy" | "reconciliation-required",
    ][] = [
      [{ readArtifact: () => undefined }, "reconciliation-required"],
      [
        {
          readArtifact: () => ({
            state: "present",
            physicalIdentity: "dev:external",
            content: encodeLocalSqliteFenceRecord(
              parseLocalSqliteFenceRecord(fenceRequest())!,
            ),
          }),
        },
        "busy",
      ],
      [{ listLifecycle: () => undefined }, "reconciliation-required"],
      [{ createLeaseDurably: () => undefined }, "reconciliation-required"],
      [{ createLeaseDurably: () => ({ state: "exists" }) }, "busy"],
      [
        {
          createLeaseDurably: () => ({
            state: "created",
            physicalIdentity: "dev:missing",
          }),
        },
        "reconciliation-required",
      ],
    ];
    for (const [overrides, state] of cases) {
      const memory = createMemoryPort();
      expect(
        await acquireLocalSqliteSharedLease(
          { ...memory.port, ...overrides },
          sharedRequest(),
        ),
      ).toEqual({ ok: false, state });
    }

    expect(await acquireLocalSqliteSharedLease({}, sharedRequest())).toEqual({
      ok: false,
      state: "unavailable",
    });
    expect(
      await acquireLocalSqliteSharedLease(createMemoryPort().port, null),
    ).toEqual({ ok: false, state: "unavailable" });

    for (const content of [
      "malformed".padEnd(256, " "),
      encodeLocalSqliteFenceRecord(
        parseLocalSqliteFenceRecord({
          ...fenceRequest(),
          lifecycleFingerprint: `sha256-${"b".repeat(64)}`,
        })!,
      )!,
    ]) {
      const memory = createMemoryPort();
      expect(
        await acquireLocalSqliteSharedLease(
          {
            ...memory.port,
            readArtifact: () => ({
              state: "present",
              physicalIdentity: "dev:existing",
              content,
            }),
          },
          sharedRequest(),
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }

    const full = createMemoryPort();
    expect(
      await acquireLocalSqliteSharedLease(
        {
          ...full.port,
          listLifecycle: () => ({
            entries: Array.from({ length: 64 }, (_, index) => ({
              name: `lease-${(index + 1).toString(16).padStart(32, "0")}.json`,
              bytes: 256,
              physicalIdentity: `dev:${index}`,
            })),
          }),
        },
        sharedRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const corrupt = createMemoryPort();
    expect(
      await acquireLocalSqliteSharedLease(
        {
          ...corrupt.port,
          readArtifact: ({ filename }: ReadArtifactInput) =>
            filename.startsWith("lease-")
              ? {
                  state: "present",
                  physicalIdentity: "dev:ino1",
                  content: "bad".padEnd(256, " "),
                }
              : { state: "absent" },
        },
        sharedRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const failedCleanup = createMemoryPort();
    failedCleanup.setFenceRace();
    expect(
      await acquireLocalSqliteSharedLease(
        {
          ...failedCleanup.port,
          removeArtifactIfIdentity: () => undefined,
        },
        sharedRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
  });
});

describe("Local SQLite existing shared-lease validation", () => {
  it("rejects every malformed or lifecycle-incompatible existing lease", async () => {
    for (const existingContent of [
      "malformed".padEnd(256, " "),
      encodeLocalSqliteLeaseRecord({
        ...leaseRecord(),
        leaseId: "9".repeat(32),
        lifecycleFingerprint: `sha256-${"b".repeat(64)}`,
      })!,
    ]) {
      const existingLease = createMemoryPort();
      existingLease.artifacts.set(`lease-${"9".repeat(32)}.json`, {
        content: existingContent,
        physicalIdentity: "dev:existing-lease",
      });
      expect(
        await acquireLocalSqliteSharedLease(
          existingLease.port,
          sharedRequest(),
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }

    const compatibleLease = createMemoryPort();
    compatibleLease.artifacts.set(`lease-${"9".repeat(32)}.json`, {
      content: encodeLocalSqliteLeaseRecord({
        ...leaseRecord(),
        leaseId: "9".repeat(32),
      })!,
      physicalIdentity: "dev:compatible-lease",
    });
    compatibleLease.artifacts.set("ownership-receipt-v1.json", {
      content: "receipt",
      physicalIdentity: "dev:receipt",
    });
    expect(
      await acquireLocalSqliteSharedLease(
        compatibleLease.port,
        sharedRequest(),
      ),
    ).toMatchObject({ ok: true });

    for (const [name, content] of [
      ["intent-v1.json", "intent"],
      ["operation-phase-v1.json", "phase"],
      [`lease-cleanup-${leaseId}.json`, "malformed"],
      [
        `lease-cleanup-${"9".repeat(32)}.json`,
        encodeLocalSqliteLeaseRecord({
          ...leaseRecord(),
          leaseId: "9".repeat(32),
        })!,
      ],
    ] as const) {
      const claimed = createMemoryPort();
      claimed.artifacts.set(name, {
        content,
        physicalIdentity: "dev:claim",
      });
      expect(
        await acquireLocalSqliteSharedLease(claimed.port, sharedRequest()),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }
  });
});

describe("Local SQLite shared fence reread containment", () => {
  it("cleans its lease before classifying missing or malformed final fences", async () => {
    for (const finalFence of [
      undefined,
      {
        state: "present",
        physicalIdentity: "dev:malformed-fence",
        content: "malformed".padEnd(256, " "),
      },
    ]) {
      const memory = createMemoryPort();
      const read = memory.port.readArtifact;
      let fenceReads = 0;
      expect(
        await acquireLocalSqliteSharedLease(
          {
            ...memory.port,
            readArtifact: (input: ReadArtifactInput) => {
              if (input.filename !== "exclusive-fence-v1") return read(input);
              fenceReads += 1;
              return fenceReads === 1 ? { state: "absent" } : finalFence;
            },
          },
          sharedRequest(),
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
      expect(memory.artifacts.has(`lease-${leaseId}.json`)).toBe(false);
    }
  });
});

describe("Local SQLite exclusive gate failure containment", () => {
  it("fails closed across exclusive publication, inventory, and owner classification", async () => {
    const publicationCases: readonly [
      Partial<LocalSqliteLifecycleGatePort>,
      "busy" | "reconciliation-required",
    ][] = [
      [{ createFenceDurably: () => undefined }, "reconciliation-required"],
      [
        {
          createFenceDurably: () => ({ state: "exists" }),
          readArtifact: () => undefined,
        },
        "reconciliation-required",
      ],
      [
        {
          createFenceDurably: () => ({ state: "exists" }),
          readArtifact: () => ({
            state: "present",
            physicalIdentity: "dev:existing",
            content: encodeLocalSqliteFenceRecord(
              parseLocalSqliteFenceRecord(fenceRequest())!,
            ),
          }),
        },
        "busy",
      ],
      [
        {
          createFenceDurably: () => ({
            state: "created",
            physicalIdentity: "dev:missing",
          }),
        },
        "reconciliation-required",
      ],
      [
        {
          createFenceDurably: () => ({ state: "exists" }),
          readArtifact: () => ({
            state: "present",
            physicalIdentity: "dev:existing",
            content: "malformed".padEnd(256, " "),
          }),
        },
        "reconciliation-required",
      ],
    ];
    for (const [overrides, state] of publicationCases) {
      const memory = createMemoryPort();
      expect(
        await acquireLocalSqliteExclusiveFence(
          { ...memory.port, ...overrides },
          fenceRequest(),
        ),
      ).toEqual({ ok: false, state });
    }

    const malformedInventory = createMemoryPort();
    expect(
      await acquireLocalSqliteExclusiveFence(
        { ...malformedInventory.port, listLifecycle: () => undefined },
        fenceRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(malformedInventory.artifacts.has("exclusive-fence-v1")).toBe(false);
    const failedFenceCleanup = createMemoryPort();
    expect(
      await acquireLocalSqliteExclusiveFence(
        {
          ...failedFenceCleanup.port,
          listLifecycle: () => undefined,
          removeArtifactIfIdentity: () => ({ state: "mismatch" }),
        },
        fenceRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    for (const entries of [
      [],
      [
        {
          name: "exclusive-fence-v1",
          bytes: 256,
          physicalIdentity: "dev:wrong",
        },
      ],
    ]) {
      const missingPublishedFence = createMemoryPort();
      expect(
        await acquireLocalSqliteExclusiveFence(
          {
            ...missingPublishedFence.port,
            listLifecycle: () => ({ entries }),
          },
          fenceRequest(),
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }
  });
});

describe("Local SQLite exclusive owner-proof containment", () => {
  it("rejects malformed owner proofs and missing lease evidence", async () => {
    for (const ownerResult of [undefined, { state: "future" }] as const) {
      const memory = createMemoryPort();
      expect(
        await acquireLocalSqliteSharedLease(memory.port, sharedRequest()),
      ).toMatchObject({ ok: true });
      expect(
        await acquireLocalSqliteExclusiveFence(
          { ...memory.port, classifyOwner: () => ownerResult },
          memory.recoveryRequest(),
        ),
      ).toEqual({ ok: false, state: "reconciliation-required" });
    }
    const childClassification = createMemoryPort();
    const childShared = await acquireLocalSqliteSharedLease(
      childClassification.port,
      sharedRequest(),
    );
    if (!childShared.ok) throw new Error("expected shared authority");
    const childAmended = await amendLocalSqliteLeaseWithChild(
      childClassification.port,
      childShared.value,
      { nonce: childNonce, pid: 202, startIdentity: childStart },
    );
    if (!childAmended.ok) throw new Error("expected child authority");
    childClassification.ownerStates.set(parentStart, "dead");
    let classificationCalls = 0;
    expect(
      await acquireLocalSqliteExclusiveFence(
        {
          ...childClassification.port,
          classifyOwner: () =>
            (classificationCalls += 1) === 1 ? { state: "dead" } : undefined,
        },
        childClassification.recoveryRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const missingLease = createMemoryPort();
    expect(
      await acquireLocalSqliteSharedLease(missingLease.port, sharedRequest()),
    ).toMatchObject({ ok: true });
    const originalRead = missingLease.port.readArtifact;
    expect(
      await acquireLocalSqliteExclusiveFence(
        {
          ...missingLease.port,
          readArtifact: (input: ReadArtifactInput) =>
            input.filename.startsWith("lease-")
              ? { state: "absent" }
              : originalRead(input),
        },
        missingLease.recoveryRequest(),
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(await acquireLocalSqliteExclusiveFence({}, fenceRequest())).toEqual({
      ok: false,
      state: "unavailable",
    });

    const mismatchedLifecycle = createMemoryPort();
    expect(
      await acquireLocalSqliteSharedLease(
        mismatchedLifecycle.port,
        sharedRequest(),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await acquireLocalSqliteExclusiveFence(mismatchedLifecycle.port, {
        ...mismatchedLifecycle.recoveryRequest(),
        lifecycleFingerprint: `sha256-${"b".repeat(64)}`,
      }),
    ).toEqual({ ok: false, state: "unavailable" });
  });
});

describe("Local SQLite gate authority containment", () => {
  it("contains stale amend and release authorities and ambiguous mutations", async () => {
    const memory = createMemoryPort();
    const acquired = await acquireLocalSqliteSharedLease(
      memory.port,
      sharedRequest(),
    );
    if (!acquired.ok) throw new Error("expected shared authority");
    const child = { nonce: childNonce, pid: 202, startIdentity: childStart };
    expect(
      await amendLocalSqliteLeaseWithChild({}, acquired.value, child),
    ).toEqual({ ok: false, state: "unavailable" });
    expect(
      await amendLocalSqliteLeaseWithChild(memory.port, {}, child),
    ).toEqual({ ok: false, state: "unavailable" });
    expect(
      await amendLocalSqliteLeaseWithChild(
        { ...memory.port, readArtifact: () => ({ state: "absent" }) },
        acquired.value,
        child,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await amendLocalSqliteLeaseWithChild(
        {
          ...memory.port,
          replaceLeaseDurably: ({ filename, content }: ReplaceLeaseInput) => {
            memory.artifacts.set(filename, {
              content: `${content.slice(0, 255)}x`,
              physicalIdentity: "dev:replacement",
            });
            return {
              state: "replaced",
              physicalIdentity: "dev:replacement",
            };
          },
        },
        acquired.value,
        child,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await amendLocalSqliteLeaseWithChild(
        { ...memory.port, replaceLeaseDurably: () => undefined },
        acquired.value,
        child,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    const mismatchMemory = createMemoryPort();
    const mismatchShared = await acquireLocalSqliteSharedLease(
      mismatchMemory.port,
      sharedRequest(),
    );
    if (!mismatchShared.ok) throw new Error("expected mismatch authority");
    expect(
      await amendLocalSqliteLeaseWithChild(
        {
          ...mismatchMemory.port,
          replaceLeaseDurably: () => ({ state: "mismatch" }),
        },
        mismatchShared.value,
        child,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    expect(await releaseLocalSqliteSharedLease({}, acquired.value)).toEqual({
      ok: false,
      state: "unavailable",
    });
    const removalMemory = createMemoryPort();
    const removalShared = await acquireLocalSqliteSharedLease(
      removalMemory.port,
      sharedRequest(),
    );
    if (!removalShared.ok) throw new Error("expected removal authority");
    expect(
      await releaseLocalSqliteSharedLease(
        {
          ...removalMemory.port,
          removeArtifactIfIdentity: () => ({ state: "mismatch" }),
        },
        removalShared.value,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await releaseLocalSqliteSharedLease(
        { ...memory.port, readArtifact: () => ({ state: "absent" }) },
        acquired.value,
      ),
    ).toEqual({ ok: true, state: "released" });

    const exclusiveMemory = createMemoryPort();
    const exclusive = await acquireLocalSqliteExclusiveFence(
      exclusiveMemory.port,
      fenceRequest(),
    );
    if (!exclusive.ok) throw new Error("expected exclusive authority");
    expect(await releaseLocalSqliteExclusiveFence({}, exclusive.value)).toEqual(
      {
        ok: false,
        state: "unavailable",
      },
    );
    expect(
      await releaseLocalSqliteExclusiveFence(
        {
          ...exclusiveMemory.port,
          removeArtifactIfIdentity: () => ({ state: "mismatch" }),
        },
        exclusive.value,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await releaseLocalSqliteExclusiveFence(
        { ...exclusiveMemory.port, readArtifact: () => ({ state: "absent" }) },
        exclusive.value,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
  });
});

describe("Local SQLite dead-lease recovery containment", () => {
  it("fails closed at every dead-lease recovery proof boundary", async () => {
    const filename = `lease-${leaseId}.json`;
    expect(await recoverDeadLocalSqliteLease({}, {}, filename)).toEqual({
      ok: false,
      state: "unavailable",
    });

    const busy = await createDeadLeaseRecovery();
    busy.memory.ownerStates.set(parentStart, "live");
    expect(
      await recoverDeadLocalSqliteLease(
        busy.memory.port,
        busy.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "busy" });

    const claimFailure = await createDeadLeaseRecovery();
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...claimFailure.memory.port,
          createLeaseCleanupClaim: () => undefined,
        },
        claimFailure.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const missingFence = await createDeadLeaseRecovery();
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...missingFence.memory.port,
          readArtifact: () => ({ state: "absent" }),
        },
        missingFence.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const missingLease = await createDeadLeaseRecovery();
    missingLease.memory.artifacts.delete(filename);
    expect(
      await recoverDeadLocalSqliteLease(
        missingLease.memory.port,
        missingLease.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const claimDrift = await createDeadLeaseRecovery();
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...claimDrift.memory.port,
          createLeaseCleanupClaim: () => ({
            state: "created",
            physicalIdentity: "dev:wrong",
          }),
        },
        claimDrift.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const claimReadDrift = await createDeadLeaseRecovery();
    const originalRead = claimReadDrift.memory.port.readArtifact;
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...claimReadDrift.memory.port,
          readArtifact: (input: ReadArtifactInput) =>
            input.filename.startsWith("lease-cleanup-")
              ? { state: "absent" }
              : originalRead(input),
        },
        claimReadDrift.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
  });
});

describe("Local SQLite dead-lease cleanup crash containment", () => {
  it("keeps claim-first cleanup resumable at every unlink prefix", async () => {
    const filename = `lease-${leaseId}.json`;
    const removalFailure = await createDeadLeaseRecovery();
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...removalFailure.memory.port,
          removeArtifactIfIdentity: () => ({ state: "mismatch" }),
        },
        removalFailure.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const resumableRemoval = await createDeadLeaseRecovery();
    let removalCalls = 0;
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...resumableRemoval.memory.port,
          removeArtifactIfIdentity: (input: RemoveArtifactInput) =>
            (removalCalls += 1) === 2
              ? { state: "mismatch" }
              : resumableRemoval.memory.port.removeArtifactIfIdentity(input),
        },
        resumableRemoval.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(resumableRemoval.memory.artifacts.has(filename)).toBe(false);
    expect(
      resumableRemoval.memory.artifacts.has(`lease-cleanup-${leaseId}.json`),
    ).toBe(true);
    expect(
      await recoverDeadLocalSqliteLease(
        resumableRemoval.memory.port,
        resumableRemoval.recovery.value,
        filename,
      ),
    ).toEqual({ ok: true, state: "recovered" });

    const lifecycleDrift = await createDeadLeaseRecovery();
    const stored = lifecycleDrift.memory.artifacts.get(filename);
    if (stored === undefined) throw new Error("expected stored lease");
    const parsed = decodeLocalSqliteLeaseRecord(stored.content);
    if (parsed === undefined) throw new Error("expected parsed lease");
    lifecycleDrift.memory.artifacts.set(filename, {
      ...stored,
      content: encodeLocalSqliteLeaseRecord({
        ...parsed,
        lifecycleFingerprint: `sha256-${"b".repeat(64)}`,
      })!,
    });
    expect(
      await recoverDeadLocalSqliteLease(
        lifecycleDrift.memory.port,
        lifecycleDrift.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });

    const claimCrash = await createDeadLeaseRecovery();
    const createClaim = claimCrash.memory.port.createLeaseCleanupClaim;
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...claimCrash.memory.port,
          createLeaseCleanupClaim: (input: CreateLeaseCleanupClaimInput) => {
            createClaim(input);
            return undefined;
          },
        },
        claimCrash.recovery.value,
        filename,
      ),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(
      await recoverDeadLocalSqliteLease(
        {
          ...claimCrash.memory.port,
          createLeaseCleanupClaim: () => ({ state: "exists" }),
        },
        claimCrash.recovery.value,
        filename,
      ),
    ).toEqual({ ok: true, state: "recovered" });
  });
});

describe("Local SQLite read-only lifecycle inspection", () => {
  it("validates a present fence during read-only inspection", async () => {
    const memory = createMemoryPort();
    const exclusive = await acquireLocalSqliteExclusiveFence(
      memory.port,
      fenceRequest(),
    );
    if (!exclusive.ok) throw new Error("expected exclusive authority");
    expect(await inspectLocalSqliteLifecycleInventory(memory.port)).toEqual({
      ok: true,
      state: "busy",
      entries: 1,
      leases: 0,
      bytes: 256,
      fence: "present",
    });
    expect(
      await inspectLocalSqliteLifecycleInventory({
        ...memory.port,
        readArtifact: () => ({ state: "absent" }),
      }),
    ).toEqual({ ok: false, state: "reconciliation-required" });
    expect(await inspectLocalSqliteLifecycleInventory({})).toEqual({
      ok: false,
      state: "unavailable",
    });
  });

  it("decodes every lease and rejects blocking or raced inventory", async () => {
    const malformed = createMemoryPort();
    malformed.artifacts.set(`lease-${leaseId}.json`, {
      content: "malformed".padEnd(256, " "),
      physicalIdentity: "dev:malformed",
    });
    expect(await inspectLocalSqliteLifecycleInventory(malformed.port)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });

    const valid = createMemoryPort();
    valid.artifacts.set(`lease-${leaseId}.json`, {
      content: encodeLocalSqliteLeaseRecord(leaseRecord())!,
      physicalIdentity: "dev:valid",
    });
    expect(await inspectLocalSqliteLifecycleInventory(valid.port)).toEqual({
      ok: true,
      state: "busy",
      entries: 1,
      leases: 1,
      bytes: 256,
      fence: "absent",
    });
    valid.artifacts.set("ownership-receipt-v1.json", {
      content: "receipt",
      physicalIdentity: "dev:receipt",
    });
    const reorderList = valid.port.listLifecycle;
    let listCalls = 0;
    expect(
      await inspectLocalSqliteLifecycleInventory({
        ...valid.port,
        listLifecycle: () => {
          listCalls += 1;
          const inventory = reorderList() as { entries: unknown[] };
          return listCalls === 2
            ? { entries: [...inventory.entries].reverse() }
            : inventory;
        },
      }),
    ).toMatchObject({ ok: true, state: "busy", entries: 2 });
    valid.artifacts.delete("ownership-receipt-v1.json");
    valid.artifacts.set(`lease-${"9".repeat(32)}.json`, {
      content: encodeLocalSqliteLeaseRecord({
        ...leaseRecord(),
        leaseId: "9".repeat(32),
        lifecycleGeneration: 2,
      })!,
      physicalIdentity: "dev:other-lifecycle",
    });
    expect(await inspectLocalSqliteLifecycleInventory(valid.port)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });

    const blocked = createMemoryPort();
    blocked.artifacts.set("intent-v1.json", {
      content: "intent",
      physicalIdentity: "dev:intent",
    });
    expect(await inspectLocalSqliteLifecycleInventory(blocked.port)).toEqual({
      ok: false,
      state: "reconciliation-required",
    });

    const raced = createMemoryPort();
    const list = raced.port.listLifecycle;
    let lists = 0;
    expect(
      await inspectLocalSqliteLifecycleInventory({
        ...raced.port,
        listLifecycle: () => {
          lists += 1;
          if (lists === 2)
            raced.artifacts.set("ownership-receipt-v1.json", {
              content: "receipt",
              physicalIdentity: "dev:receipt",
            });
          return list();
        },
      }),
    ).toEqual({ ok: false, state: "unavailable" });

    expect(
      await inspectLocalSqliteLifecycleInventory({
        ...createMemoryPort().port,
        listLifecycle: () => undefined,
      }),
    ).toEqual({ ok: false, state: "reconciliation-required" });
  });
});

describe("Local SQLite lifecycle record codec", () => {
  it("round trips canonical fixed-width lease and fence records", () => {
    const lease = parseLocalSqliteLeaseRecord(leaseRecord());
    const fence = parseLocalSqliteFenceRecord(fenceRequest());
    expect(lease).toBeDefined();
    expect(fence).toBeDefined();
    if (lease === undefined || fence === undefined) throw new Error("codec");
    const leaseBytes = encodeLocalSqliteLeaseRecord(lease);
    const fenceBytes = encodeLocalSqliteFenceRecord(fence);
    expect(leaseBytes).toHaveLength(256);
    expect(fenceBytes).toHaveLength(256);
    expect(decodeLocalSqliteLeaseRecord(leaseBytes)).toEqual(lease);
    expect(decodeLocalSqliteFenceRecord(fenceBytes)).toEqual(fence);
    const recoveryFence = parseLocalSqliteFenceRecord({
      ...recoveryPlanRequest(),
      purpose: "recovery",
      deadLeaseVector: [
        {
          originalState: "lease-only",
          physicalIdentity: "dev:1:ino:2",
          record: lease,
        },
      ],
    });
    expect(recoveryFence?.purpose).toBe("recovery");
    const recoveryBytes = encodeLocalSqliteFenceRecord(recoveryFence);
    expect(recoveryBytes?.length).toBeGreaterThan(256);
    expect(recoveryBytes?.length).toBeLessThanOrEqual(32_768);
    expect(decodeLocalSqliteFenceRecord(recoveryBytes)).toEqual(recoveryFence);
  });

  it.each([
    null,
    [],
    Object.create(null),
    { ...leaseRecord(), extra: true },
    { ...leaseRecord(), leaseId: "0".repeat(32) },
    { ...leaseRecord(), leaseId: "A".repeat(32) },
    { ...leaseRecord(), lifecycleFingerprint: "bad" },
    { ...leaseRecord(), lifecycleGeneration: 0 },
    { ...leaseRecord(), lifecycleGeneration: 2_147_483_648 },
    { ...leaseRecord(), parent: null },
    { ...leaseRecord(), parent: { pid: 0, startIdentity: parentStart } },
    { ...leaseRecord(), parent: { pid: 1, startIdentity: "bad" } },
    { ...leaseRecord(), child: {} },
    {
      ...leaseRecord(),
      child: { nonce: "0".repeat(32), pid: 2, startIdentity: childStart },
    },
    {
      ...leaseRecord(),
      child: { nonce: childNonce, pid: 0, startIdentity: childStart },
    },
    {
      ...leaseRecord(),
      child: { nonce: childNonce, pid: 2, startIdentity: "bad" },
    },
  ])("rejects invalid lease DTO %# without coercion", (value) => {
    expect(parseLocalSqliteLeaseRecord(value)).toBeUndefined();
  });
});

describe("Local SQLite lifecycle encoded-record containment", () => {
  it.each([
    null,
    [],
    { ...fenceRequest(), extra: true },
    { ...fenceRequest(), transactionId: "0".repeat(32) },
    { ...fenceRequest(), lifecycleFingerprint: "bad" },
    { ...fenceRequest(), lifecycleGeneration: 0 },
    { ...fenceRequest(), purpose: "future" },
  ])("rejects invalid fence DTO %#", (value) => {
    expect(parseLocalSqliteFenceRecord(value)).toBeUndefined();
  });

  it("rejects noncanonical and malformed encoded records", () => {
    const lease = parseLocalSqliteLeaseRecord(leaseRecord());
    const fence = parseLocalSqliteFenceRecord(fenceRequest());
    if (lease === undefined || fence === undefined) throw new Error("codec");
    const leaseBytes = encodeLocalSqliteLeaseRecord(lease)!;
    const fenceBytes = encodeLocalSqliteFenceRecord(fence)!;
    const compactLease = leaseBytes.trimEnd();
    const compactFence = fenceBytes.trimEnd();
    const leaseValues = JSON.parse(compactLease) as unknown[];
    const fenceValues = JSON.parse(compactFence) as unknown[];
    const invalidLeaseBytes = [
      undefined,
      "short",
      `${leaseBytes.slice(0, 255)}\n`,
      "{".padEnd(256, " "),
      JSON.stringify([2, ...leaseValues.slice(1)]).padEnd(256, " "),
      JSON.stringify([...leaseValues.slice(0, 4), [], null]).padEnd(256, " "),
      JSON.stringify([...leaseValues.slice(0, 5), []]).padEnd(256, " "),
      JSON.stringify([...leaseValues, "extra"]).padEnd(256, " "),
      ` ${compactLease}`.padEnd(256, " "),
    ];
    for (const bytes of invalidLeaseBytes)
      expect(decodeLocalSqliteLeaseRecord(bytes)).toBeUndefined();
    const invalidFenceBytes = [
      undefined,
      "short",
      `${fenceBytes.slice(0, 255)}\n`,
      "{".padEnd(256, " "),
      JSON.stringify([2, ...fenceValues.slice(1)]).padEnd(256, " "),
      JSON.stringify([...fenceValues, "extra"]).padEnd(256, " "),
      ` ${compactFence}`.padEnd(256, " "),
    ];
    for (const bytes of invalidFenceBytes)
      expect(decodeLocalSqliteFenceRecord(bytes)).toBeUndefined();
  });

  it("rejects records that cannot fit the fixed 256-byte envelope", () => {
    expect(
      encodeLocalSqliteLeaseRecord({
        ...leaseRecord(),
        lifecycleFingerprint: "x".repeat(512),
      }),
    ).toBeUndefined();
    expect(
      encodeLocalSqliteFenceRecord({
        ...fenceRequest(),
        lifecycleFingerprint: "x".repeat(512),
      }),
    ).toBeUndefined();
  });

  it("contains accessor, symbol, sparse, and revoked-proxy structures", () => {
    let getterCalls = 0;
    const accessor = { ...leaseRecord() };
    Object.defineProperty(accessor, "leaseId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return leaseId;
      },
    });
    expect(parseLocalSqliteLeaseRecord(accessor)).toBeUndefined();
    expect(encodeLocalSqliteLeaseRecord(accessor)).toBeUndefined();
    expect(getterCalls).toBe(0);

    const symbol = { ...leaseRecord(), [Symbol("extra")]: true };
    expect(parseLocalSqliteLeaseRecord(symbol)).toBeUndefined();

    const lease = parseLocalSqliteLeaseRecord(leaseRecord());
    if (lease === undefined) throw new Error("lease");
    const encoded = encodeLocalSqliteLeaseRecord(lease)!;
    const compact = JSON.parse(encoded.trimEnd()) as unknown[];
    const sparse = new Array<unknown>(2);
    sparse[1] = parentStart;
    compact[4] = sparse;
    expect(
      decodeLocalSqliteLeaseRecord(JSON.stringify(compact).padEnd(256, " ")),
    ).toBeUndefined();

    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(
      parseLocalSqliteLeaseRecord({ ...leaseRecord(), child: proxy }),
    ).toBe(undefined);
  });
});
