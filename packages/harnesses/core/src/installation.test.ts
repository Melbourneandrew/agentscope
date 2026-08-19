import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
  resumeHarnessInstallation,
  rollbackHarnessInstallation,
  type HarnessInstallationPlanInput,
  type HarnessTargetDecision,
} from "./installation.js";

const roots: string[] = [];
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-installation-"));
  roots.push(root);
  return root;
};
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const absentDigest = digest("");
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const artifactPrefix = (transactionId: string, targetPath: string): string =>
  join(
    join(targetPath, ".."),
    `.agentscope-${transactionId}-${createHash("sha256")
      .update(targetPath)
      .digest("hex")
      .slice(0, 16)}`,
  );

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const planInput = (
  root: string,
  targetPaths: readonly string[],
  planner: HarnessInstallationPlanInput["planner"],
): HarnessInstallationPlanInput => ({
  manifestPath: join(root, "transactions", "hook.json"),
  operation: "install",
  targetPaths,
  planner,
});

describe("harness installation transaction", () => {
  it("creates and updates multiple targets atomically while preserving modes", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    await writeFile(first, "old-first", { mode: 0o640 });
    const plan = await inspectHarnessInstallation(
      planInput(root, [first, second], ({ targetPath }) => ({
        kind: "replace",
        bytes: bytes(targetPath === first ? "new-first" : "new-second"),
      })),
    );
    expect(plan).toMatchObject({
      disposition: "ready",
      targetCount: 2,
      changedTargetCount: 2,
    });
    await chmod(first, 0o640);
    await expect(applyHarnessInstallation(plan)).resolves.toEqual({
      ok: true,
      state: "committed",
      changedTargetCount: 2,
    });
    expect(await readFile(first, "utf8")).toBe("new-first");
    expect((await lstat(first)).mode & 0o777).toBe(0o640);
    expect(await readFile(second, "utf8")).toBe("new-second");
    expect((await lstat(second)).mode & 0o777).toBe(0o600);
    await expect(applyHarnessInstallation(plan)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
  });

  it("supports unchanged, remove, conflict, unsupported, and recovery-required plans", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    await writeFile(target, "owned");
    const unchanged = await inspectHarnessInstallation(
      planInput(root, [target], () => ({ kind: "unchanged" })),
    );
    expect(unchanged.disposition).toBe("unchanged");
    await expect(applyHarnessInstallation(unchanged)).resolves.toMatchObject({
      ok: true,
      state: "unchanged",
    });
    for (const [kind, expected] of [
      ["conflict", "conflict"],
      ["unsupported", "unsupported"],
    ] as const) {
      const plan = await inspectHarnessInstallation(
        planInput(root, [target], () => ({ kind })),
      );
      expect(plan.disposition).toBe(expected);
      await expect(applyHarnessInstallation(plan)).resolves.toMatchObject({
        ok: false,
        state: expected,
      });
    }
    const removal = await inspectHarnessInstallation(
      planInput(root, [target], () => ({ kind: "remove" })),
    );
    await expect(applyHarnessInstallation(removal)).resolves.toMatchObject({
      ok: true,
      state: "committed",
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(root, "transactions"), { recursive: true });
    await writeFile(join(root, "transactions", "hook.json"), "occupied");
    const recovery = await inspectHarnessInstallation(
      planInput(root, [target], () => ({
        kind: "replace",
        bytes: bytes("new"),
      })),
    );
    expect(recovery.disposition).toBe("recovery-required");
  });

  it("detects a concurrent vendor edit before applying any target", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    await writeFile(target, "observed");
    const plan = await inspectHarnessInstallation(
      planInput(root, [target], () => ({
        kind: "replace",
        bytes: bytes("owned"),
      })),
    );
    await writeFile(target, "vendor-edit");
    await expect(applyHarnessInstallation(plan)).resolves.toEqual({
      ok: false,
      state: "conflict",
      changedTargetCount: 0,
    });
    expect(await readFile(target, "utf8")).toBe("vendor-edit");
  });
});

describe("harness installation admission", () => {
  it("treats equal replacement bytes as unchanged and rechecks manifest admission", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    await writeFile(target, "same");
    const unchanged = await inspectHarnessInstallation(
      planInput(root, [target], () => ({
        kind: "replace",
        bytes: bytes("same"),
      })),
    );
    expect(unchanged.disposition).toBe("unchanged");

    const ready = await inspectHarnessInstallation(
      planInput(root, [target], () => ({
        kind: "replace",
        bytes: bytes("new"),
      })),
    );
    await mkdir(join(root, "transactions"), { recursive: true });
    await writeFile(join(root, "transactions", "hook.json"), "occupied");
    await expect(applyHarnessInstallation(ready)).resolves.toMatchObject({
      ok: false,
      state: "recovery-required",
    });
    await expect(
      applyHarnessInstallation({ disposition: "unchanged" } as never),
    ).resolves.toMatchObject({ ok: false, state: "invalid" });
    await expect(
      applyHarnessInstallation(null as never),
    ).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
  });

  it("contains preparation filesystem failure as unavailable", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const transactionDirectory = join(root, "transactions");
    const ready = await inspectHarnessInstallation(
      planInput(root, [target], () => ({
        kind: "replace",
        bytes: bytes("new"),
      })),
    );
    await writeFile(transactionDirectory, "not-a-directory");
    await expect(applyHarnessInstallation(ready)).resolves.toMatchObject({
      ok: false,
      state: "unavailable",
    });
    const blocked = await inspectHarnessInstallation({
      manifestPath: join(transactionDirectory, "nested.json"),
      operation: "install",
      targetPaths: [target],
      planner: () => ({ kind: "unchanged" }),
    });
    expect(blocked.disposition).toBe("unavailable");
  });

  it("requires an explicit migration operation for overlapping hooks", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    await writeFile(target, "vendor-hook");
    const planner = (): HarnessTargetDecision => ({
      kind: "replace-overlap",
      bytes: bytes("agentscope-hook"),
    });
    const ordinary = await inspectHarnessInstallation(
      planInput(root, [target], planner),
    );
    expect(ordinary.disposition).toBe("conflict");
    const migration = await inspectHarnessInstallation({
      ...planInput(root, [target], planner),
      operation: "migrate",
    });
    expect(migration.disposition).toBe("ready");
    await expect(applyHarnessInstallation(migration)).resolves.toMatchObject({
      ok: true,
      state: "committed",
    });
    expect(await readFile(target, "utf8")).toBe("agentscope-hook");
  });
});

describe("harness installation recovery", () => {
  it("resumes a prepared transaction and rolls back a committed value", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "a".repeat(32);
    const prefix = artifactPrefix(transactionId, target);
    const stagePath = `${prefix}.stage`;
    const backupPath = `${prefix}.backup`;
    await writeFile(target, "before", { mode: 0o640 });
    await writeFile(stagePath, "after", { mode: 0o640 });
    await writeFile(backupPath, "before", { mode: 0o640 });
    const manifest = {
      version: 1,
      transactionId,
      state: "prepared",
      targets: [
        {
          targetPath: target,
          beforeDigest: digest("before"),
          beforeExists: true,
          beforeMode: 0o640,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath,
          backupPath,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: true,
      state: "committed",
    });
    expect(await readFile(target, "utf8")).toBe("after");

    await writeFile(backupPath, "before", { mode: 0o640 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, state: "committed" })}\n`,
    );
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: true,
      state: "committed",
    });

    await writeFile(stagePath, "after", { mode: 0o640 });
    await writeFile(backupPath, "before", { mode: 0o640 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, state: "committed" })}\n`,
    );
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: true,
      state: "rolled-back",
    });
    expect(await readFile(target, "utf8")).toBe("before");
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
  });

  it("rolls back created targets and refuses to overwrite a later edit", async () => {
    const root = await temporaryRoot();
    const target = join(root, "created.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "b".repeat(32);
    const manifest = {
      version: 1,
      transactionId,
      state: "committed",
      targets: [
        {
          targetPath: target,
          beforeDigest: absentDigest,
          beforeExists: false,
          beforeMode: null,
          afterDigest: digest("owned"),
          afterExists: true,
          stagePath: `${artifactPrefix(transactionId, target)}.stage`,
          backupPath: null,
        },
      ],
    };
    await writeFile(target, "owned");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: true,
      state: "rolled-back",
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(target, "vendor-edit");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: false,
      state: "conflict",
    });
    expect(await readFile(target, "utf8")).toBe("vendor-edit");
  });
});

describe("harness installation recovery conflicts", () => {
  it("refuses resume over an unrelated current target and cleans unchanged rollback", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "c".repeat(32);
    const prefix = artifactPrefix(transactionId, target);
    const manifest = {
      version: 1,
      transactionId,
      state: "prepared",
      targets: [
        {
          targetPath: target,
          beforeDigest: digest("before"),
          beforeExists: true,
          beforeMode: 0o600,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath: `${prefix}.stage`,
          backupPath: `${prefix}.backup`,
        },
      ],
    };
    await writeFile(target, "vendor");
    await writeFile(`${prefix}.stage`, "after");
    await writeFile(`${prefix}.backup`, "before");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: false,
      state: "conflict",
    });
    await writeFile(target, "before");
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: true,
      state: "rolled-back",
    });
  });

  it("contains a non-file recovery artifact cleanup failure", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "e".repeat(32);
    const stagePath = `${artifactPrefix(transactionId, target)}.stage`;
    await writeFile(target, "after");
    await mkdir(stagePath);
    const manifest = {
      version: 1,
      transactionId,
      state: "committed",
      targets: [
        {
          targetPath: target,
          beforeDigest: absentDigest,
          beforeExists: false,
          beforeMode: null,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath,
          backupPath: null,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: false,
      state: "unavailable",
    });
  });

  it("contains a missing required rollback backup as unavailable", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "f".repeat(32);
    const prefix = artifactPrefix(transactionId, target);
    await writeFile(target, "after");
    const manifest = {
      version: 1,
      transactionId,
      state: "committed",
      targets: [
        {
          targetPath: target,
          beforeDigest: digest("before"),
          beforeExists: true,
          beforeMode: 0o600,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath: `${prefix}.stage`,
          backupPath: `${prefix}.backup`,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: false,
      state: "unavailable",
    });
  });
});

describe("harness installation recovery artifact integrity", () => {
  it("rejects corrupt staged and backup recovery artifacts before replacement", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.json");
    const manifestPath = join(root, "transaction.json");
    const transactionId = "7".repeat(32);
    const prefix = artifactPrefix(transactionId, target);
    const stagePath = `${prefix}.stage`;
    const backupPath = `${prefix}.backup`;
    const manifest = {
      version: 1,
      transactionId,
      state: "prepared",
      targets: [
        {
          targetPath: target,
          beforeDigest: digest("before"),
          beforeExists: true,
          beforeMode: 0o600,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath,
          backupPath,
        },
      ],
    };

    await writeFile(target, "before", { mode: 0o600 });
    await writeFile(stagePath, "corrupt-stage", { mode: 0o600 });
    await writeFile(backupPath, "before", { mode: 0o600 });
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({ ok: false, state: "conflict" });
    expect(await readFile(target, "utf8")).toBe("before");
    await unlink(stagePath);
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({ ok: false, state: "unavailable" });
    expect(await readFile(target, "utf8")).toBe("before");

    await writeFile(target, "after", { mode: 0o600 });
    await writeFile(backupPath, "corrupt-backup", { mode: 0o600 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, state: "committed" })}\n`,
    );
    await expect(
      rollbackHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({ ok: false, state: "conflict" });
    expect(await readFile(target, "utf8")).toBe("after");
  });
});

describe("harness installation hostile boundaries", () => {
  it("fails closed for symlinks, malformed plans, callbacks, and manifests", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    await writeFile(target, "value");
    await symlink(target, linked);
    const symlinkPlan = await inspectHarnessInstallation(
      planInput(root, [linked], () => ({
        kind: "replace",
        bytes: bytes("new"),
      })),
    );
    expect(symlinkPlan.disposition).toBe("invalid");

    const hostileDecisions: Array<() => HarnessTargetDecision> = [
      () => ({ kind: "replace", bytes: new Uint8Array(1_048_577) }),
      () => ({ kind: "replace", bytes: bytes("x"), extra: true }) as never,
      () => ({ kind: "unchanged", extra: true }) as never,
      () => ({ kind: "unknown" }) as never,
      () => null as never,
      () =>
        Object.defineProperty({ kind: "unchanged" }, "extra", {
          get: () => true,
        }) as never,
      () => ({
        kind: "replace",
        bytes: Object.assign(bytes("x"), { extra: true }),
      }),
      () => ({
        kind: "replace",
        bytes: new Proxy(bytes("x"), {}),
      }),
      () => ({
        kind: "replace",
        bytes: new (class extends Uint8Array {})([1]),
      }),
      () => {
        throw new Error("CANARY");
      },
    ];
    for (const planner of hostileDecisions) {
      const plan = await inspectHarnessInstallation(
        planInput(root, [target], planner),
      );
      expect(plan.disposition).toBe("invalid");
    }
    for (const input of [
      {
        ...planInput(root, [target], () => ({ kind: "unchanged" })),
        extra: true,
      },
      planInput(root, [], () => ({ kind: "unchanged" })),
      planInput(root, ["relative"], () => ({ kind: "unchanged" })),
      planInput(root, [target, target], () => ({ kind: "unchanged" })),
      {
        ...planInput(root, [target], () => ({ kind: "unchanged" })),
        targetPaths: "not-an-array",
      },
      {
        ...planInput(root, [target], () => ({ kind: "unchanged" })),
        operation: "replace",
      },
      {
        ...planInput(root, [target], () => ({ kind: "unchanged" })),
        targetPaths: new Proxy([target], {
          ownKeys() {
            throw new Error("CANARY");
          },
        }),
      },
      Object.create(null) as object,
    ]) {
      const plan = await inspectHarnessInstallation(
        input as HarnessInstallationPlanInput,
      );
      expect(plan.disposition).toBe("invalid");
    }
  });
});

describe("harness installation filesystem boundaries", () => {
  it("fails closed for malformed, missing, linked, and oversized files", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.json");
    const manifest = join(root, "malformed.json");
    await writeFile(manifest, "{}\n");
    await expect(resumeHarnessInstallation(manifest)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    await expect(
      rollbackHarnessInstallation("relative"),
    ).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    const missing = join(root, "missing-manifest.json");
    await expect(resumeHarnessInstallation(missing)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    await expect(rollbackHarnessInstallation(missing)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    const manifestDirectory = join(root, "manifest-directory");
    await mkdir(manifestDirectory);
    const blocked = await inspectHarnessInstallation({
      manifestPath: manifestDirectory,
      operation: "install",
      targetPaths: [target],
      planner: () => ({ kind: "unchanged" }),
    });
    expect(blocked.disposition).toBe("invalid");
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, new Uint8Array(1_048_577));
    const oversizedPlan = await inspectHarnessInstallation(
      planInput(root, [oversized], () => ({ kind: "unchanged" })),
    );
    expect(oversizedPlan.disposition).toBe("invalid");
    const linkedManifest = join(root, "linked-manifest.json");
    await symlink(manifest, linkedManifest);
    await expect(
      resumeHarnessInstallation(linkedManifest),
    ).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    await writeFile(manifest, new Uint8Array(1_048_577));
    await expect(resumeHarnessInstallation(manifest)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    await writeFile(manifest, "{");
    await expect(resumeHarnessInstallation(manifest)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
    await writeFile(manifest, new Uint8Array([0xff]));
    await expect(resumeHarnessInstallation(manifest)).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
  });
});

describe("harness installation manifest validation", () => {
  it("rejects noncanonical and authority-changing recovery manifests", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.json");
    const manifestPath = join(root, "manifest.json");
    const transactionId = "d".repeat(32);
    const prefix = artifactPrefix(transactionId, target);
    const valid = {
      version: 1,
      transactionId,
      state: "prepared",
      targets: [
        {
          targetPath: target,
          beforeDigest: absentDigest,
          beforeExists: false,
          beforeMode: null,
          afterDigest: digest("after"),
          afterExists: true,
          stagePath: `${prefix}.stage`,
          backupPath: null,
        },
      ],
    };
    for (const candidate of [
      [],
      { ...valid, version: 2 },
      { ...valid, transactionId: "bad" },
      { ...valid, state: "unknown" },
      { ...valid, targets: [] },
      { ...valid, targets: [null] },
      { ...valid, targets: [{ ...valid.targets[0], targetPath: "relative" }] },
      {
        ...valid,
        targets: [{ ...valid.targets[0], stagePath: "/tmp/unowned" }],
      },
      { ...valid, extra: true },
    ]) {
      await writeFile(manifestPath, `${JSON.stringify(candidate)}\n`);
      await expect(
        resumeHarnessInstallation(manifestPath),
      ).resolves.toMatchObject({
        ok: false,
        state: "invalid",
      });
    }
    await writeFile(manifestPath, JSON.stringify(valid));
    await expect(
      resumeHarnessInstallation(manifestPath),
    ).resolves.toMatchObject({
      ok: false,
      state: "invalid",
    });
  });
});
