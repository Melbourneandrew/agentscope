import * as fileSystem from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  readImagePreparationDiagnostic,
  recordClientSetupCleanupFailure,
} from "../image-preparation/preparation.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fileSystem.rmSync(root, { recursive: true, force: true });
});
const fixedError = (code: string) => new Error(code);
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const source = (name: string) => {
  const bytes = fileSystem.readFileSync(
    new URL(`../image-preparation/${name}.mjs`, import.meta.url),
  );
  expect(bytes.length).toBeLessThan(32 * 1024);
  return bytes
    .toString()
    .replace(/^import[\s\S]*?from "[^"]+";/gmu, "")
    .replaceAll("export const ", "const ");
};
const storage = (clock: { now: number }, extra: Record<string, unknown> = {}) =>
  runInNewContext(
    `${source("private-storage")}\n({createPrivateClientRoot,cleanupPrivateClient});`,
    {
      ...fileSystem,
      mkdtempSync: (prefix: string) => {
        const path = fileSystem.mkdtempSync(prefix);
        roots.push(path);
        return path;
      },
      performance: { now: () => clock.now },
      resolve,
      process,
      Buffer,
      fixedError,
      digestBytes: digest,
      diagnosticDigest: (value: unknown) =>
        `sha256:${digest(Buffer.from(JSON.stringify(value)))}`,
      maximumPrivateStateDepth: 32,
      maximumPrivateStateEntries: 4096,
      maximumPrivateStateFileBytes: 1024 * 1024,
      maximumPrivateStateTotalBytes: 8 * 1024 * 1024,
      preparationTeardownMilliseconds: 1000,
      recordClientSetupCleanupFailure,
      integrationPrivateStorageAuthority: () => {
        throw Error("must-not-mint");
      },
      registerIntegrationPrivateStorageRetirement: () => {
        throw Error("must-not-register");
      },
      ...extra,
    },
    { timeout: 1000 },
  ) as {
    createPrivateClientRoot: (
      options: Record<string, unknown>,
      deadline?: number,
    ) => { root: string; retired: boolean; lifecycleDeadline?: number };
    cleanupPrivateClient: (owned: unknown, deadline: number) => void;
  };
const testing = { socketIdentityForTesting: {} };

describe("client setup preserves its original deadline (synthetic clock, real private files)", () => {
  it.each([NaN, Infinity, 0, 100, 300_101])(
    "rejects invalid or expired absolute deadline %s before root creation",
    (deadline) => {
      const kernel = storage({ now: 100 });
      expect(() =>
        kernel.createPrivateClientRoot({ ...testing, deadline }),
      ).toThrow("images.deadline");
      expect(roots).toHaveLength(0);
    },
  );
  it("binds the explicit lifecycle boundary and accepts legacy omission", () => {
    const clock = { now: 100 };
    const kernel = storage(clock);
    for (const deadline of [undefined, 200]) {
      const owned = kernel.createPrivateClientRoot({ ...testing, deadline });
      expect(owned.lifecycleDeadline).toBe(deadline);
      expect(Reflect.set(owned, "lifecycleDeadline", 999_999)).toBe(false);
      kernel.cleanupPrivateClient(owned, 200);
      expect(owned.retired).toBe(true);
      expect(fileSystem.existsSync(owned.root)).toBe(true); // outer-host retirement only
    }
  });
  it("retains expired setup prefixes without resetting cleanup or losing primary", () => {
    const clock = { now: 100 };
    const kernel = storage(clock);
    let failure: unknown;
    try {
      kernel.createPrivateClientRoot({
        ...testing,
        deadline: 200,
        afterPrivateRootCreatedForTesting: () => {
          clock.now = 200;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(readImagePreparationDiagnostic(failure)).toEqual({
      primary: "preparation-failed",
      cleanup: "private-cleanup-failed",
      trigger: "timeout",
      reconciliation: "not-attempted",
    });
    expect(roots).toHaveLength(1);
    expect(fileSystem.readdirSync(roots[0]!)).toEqual([]);
  });
  it("preserves an original setup exception when bounded inventory settlement succeeds", () => {
    const kernel = storage({ now: 100 });
    const primary = Error("synthetic-primary");
    expect(() =>
      kernel.createPrivateClientRoot({
        ...testing,
        deadline: 200,
        afterPrivateRootCreatedForTesting: () => {
          throw primary;
        },
      }),
    ).toThrow(primary);
    expect(fileSystem.existsSync(roots[0]!)).toBe(true);
  });
  it("never deletes a created-but-unbound root or replaces its failure with success", () => {
    const kernel = storage(
      { now: 100 },
      {
        chmodSync: () => {
          throw Error("synthetic-chmod");
        },
      },
    );
    let failure: unknown;
    try {
      kernel.createPrivateClientRoot({ ...testing, deadline: 200 });
    } catch (error) {
      failure = error;
    }
    expect(readImagePreparationDiagnostic(failure)).toMatchObject({
      primary: "preparation-failed",
      cleanup: "private-cleanup-failed",
    });
    expect(fileSystem.existsSync(roots[0]!)).toBe(true);
  });
});

const factory = (
  clock: { now: number },
  calls: number[],
  lifetime?: number,
) => {
  const owned = { lifecycleDeadline: lifetime };
  const snapshots: unknown[] = [];
  const primary = Error("synthetic-admission");
  const create = runInNewContext(
    `${source("prepared-client")}\ncreatePreparedClient;`,
    {
      performance: { now: () => clock.now },
      preparationTeardownMilliseconds: 1000,
      fixedError,
      validSocketEvidence: () => true,
      validEvidenceDaemon: () => true,
      sameSocket: () => true,
      resolveDockerExecutable: () => "/synthetic/docker",
      createPrivateClientRoot: (
        _options: unknown,
        deadline: number,
        snapshot: unknown,
      ) => {
        calls.push(deadline);
        snapshots.push(snapshot);
        clock.now = 250;
        return owned;
      },
      cleanupPrivateClient: (_owned: unknown, deadline: number) => {
        calls.push(deadline);
      },
      BUILDKIT_IMAGE: "synthetic-pinned",
      readImagePreparationDiagnostic,
      recordClientSetupCleanupFailure,
    },
    { timeout: 1000 },
  ) as (state: unknown, evidence: unknown, options: unknown) => unknown;
  return { create, primary, snapshots };
};
describe("actual constructor and close bodies clamp rather than restart", () => {
  it("snapshots the optional deadline once before setup, without later extension", () => {
    const { create, snapshots } = factory({ now: 100 }, [], 300);
    let reads = 0;
    create(
      { admitClient: () => {} },
      {
        dockerSocket: {},
        dockerDaemon: {},
        images: [{}],
      },
      {
        socketIdentityForTesting: {},
        get deadline() {
          return ++reads === 1 ? 300 : 999_999;
        },
      },
    );
    expect(reads).toBe(1);
    expect(snapshots).toEqual([{ deadline: 300 }]);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
  });
  it("rejects an expired constructor deadline before client-root creation", () => {
    const calls: number[] = [];
    const { create } = factory({ now: 100 }, calls);
    expect(() =>
      create(
        {},
        { dockerSocket: {}, dockerDaemon: {}, images: [{}] },
        { deadline: 100, socketIdentityForTesting: {} },
      ),
    ).toThrow("images.docker-client");
    expect(calls).toEqual([]);
  });
  it.each([undefined, 300])(
    "constructor rollback uses entry-captured fallback and inherited %s",
    (lifetime) => {
      const calls: number[] = [];
      const { create, primary } = factory({ now: 100 }, calls, lifetime);
      expect(() =>
        create(
          {
            admitClient: () => {
              throw primary;
            },
          },
          {
            dockerSocket: {},
            dockerDaemon: {},
            images: [{}],
          },
          { socketIdentityForTesting: {} },
        ),
      ).toThrow("images.docker-client");
      expect(calls).toEqual([1100, lifetime ?? 1100]);
    },
  );
  it("close sends the original lifecycle cutoff to the existing inventory kernel", () => {
    const calls: number[] = [];
    let uncertain = false;
    const client = { privateClient: { lifecycleDeadline: 200 } };
    const operation = runInNewContext(
      `${source("retirement")}\ncreateRetirementOperations;`,
      {
        performance: { now: () => 200 },
        preparationTeardownMilliseconds: 1000,
        fixedError,
        cleanupPrivateClient: (_owned: unknown, deadline: number) => {
          calls.push(deadline);
          if (deadline <= 200) throw Error("expired");
        },
      },
      { timeout: 1000 },
    ) as (
      state: unknown,
      docker: unknown,
    ) => { closePreparedDockerClient: (client: unknown) => void };
    const state = {
      pendingCount: () => 0,
      pendingNetworkCount: () => 0,
      pendingControlVolumeCount: () => 0,
      hasClient: () => true,
      clientIsUncertain: () => false,
      beginClose: () => {},
      endClose: () => {},
      finishClose: () => {
        throw Error("must-not-finish");
      },
      markUncertain: () => {
        uncertain = true;
      },
    };
    expect(() => {
      operation(state, {}).closePreparedDockerClient(client);
    }).toThrow("expired");
    expect(calls).toEqual([200]);
    expect(uncertain).toBe(true);
  });
});
