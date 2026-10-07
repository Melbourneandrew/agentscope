import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
} from "./installation.js";
import * as directoryPreimages from "./installation-directory-preimages.js";

const roots: string[] = [];
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-directory-plan-")),
  );
  roots.push(root);
  return {
    root,
    target: join(root, "settings.json"),
    manifest: join(root, "transaction.json"),
  };
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("same installation plan directory read dependencies", () => {
  it.each(["stable", "entries", "identity", "mode", "absence"])(
    "retains the same directory preimage across apply: %s",
    async (change) => {
      const value = await fixture();
      const directory = join(value.root, "cache");
      const before = Object.freeze({
        directoryPath: directory,
        exists: true,
        mode: 0o700,
        entries: Object.freeze(["plugin"]),
        digest: "before",
        identity: "held-directory",
      });
      const after = {
        ...before,
        ...(change === "entries"
          ? { entries: ["other"], digest: "after" }
          : {}),
        ...(change === "identity" ? { identity: "replacement" } : {}),
        ...(change === "mode" ? { mode: 0o755 } : {}),
        ...(change === "absence"
          ? { exists: false, entries: [], digest: "absent", identity: null }
          : {}),
      };
      const observer = vi
        .spyOn(directoryPreimages, "inspectDirectoryPreimage")
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      const plan = await inspectHarnessInstallation({
        manifestPath: value.manifest,
        operation: "install",
        targetPaths: [value.target],
        directoryPaths: [directory],
        planner: (_target, directories) => {
          expect(directories).toEqual([
            {
              directoryPath: directory,
              exists: true,
              mode: 0o700,
              entries: ["plugin"],
            },
          ]);
          expect(Object.isFrozen(directories)).toBe(true);
          expect(Object.isFrozen(directories?.[0]?.entries)).toBe(true);
          expect(directories?.[0]?.entries).not.toBe(before.entries);
          return { kind: "unchanged" };
        },
      });
      expect(plan.disposition).toBe("unchanged");
      expect(await applyHarnessInstallation(plan)).toMatchObject({
        ok: change === "stable",
        state: change === "stable" ? "unchanged" : "conflict",
      });
      expect(observer).toHaveBeenCalledTimes(2);
      expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
    },
  );
});

describe("directory guard composition with ordinary file plans", () => {
  it("keeps file-only installation independent of an unavailable native tuple", async () => {
    const value = await fixture();
    const plan = await inspectHarnessInstallation({
      manifestPath: value.manifest,
      operation: "install",
      targetPaths: [value.target],
      planner: (_target, directories) => {
        expect(directories).toEqual([]);
        return { kind: "replace", bytes: new TextEncoder().encode("owned") };
      },
    });
    expect(plan.disposition).toBe("ready");
    expect(await applyHarnessInstallation(plan)).toMatchObject({
      ok: true,
      state: "committed",
    });
    expect(await readFile(value.target, "utf8")).toBe("owned");
  });
  it("retains a missing directory preimage through unchanged success", async () => {
    const value = await fixture();
    const directory = join(value.root, "cache");
    const plan = await inspectHarnessInstallation({
      manifestPath: value.manifest,
      operation: "install",
      targetPaths: [value.target],
      directoryPaths: [directory],
      planner: (_target, directories) => {
        expect(directories).toEqual([
          { directoryPath: directory, exists: false, mode: null, entries: [] },
        ]);
        return { kind: "unchanged" };
      },
    });
    expect(plan.disposition).toBe("unchanged");
    await mkdir(directory);
    expect(await applyHarnessInstallation(plan)).toMatchObject({ ok: false });
    expect(await applyHarnessInstallation(plan)).toMatchObject({
      state: "invalid",
    });
  });
  it("reads all regular files before the first planner callback", async () => {
    const value = await fixture();
    const second = join(value.root, "second.json");
    await writeFile(second, "before");
    const inspected: string[] = [];
    const plan = await inspectHarnessInstallation({
      manifestPath: value.manifest,
      operation: "install",
      targetPaths: [value.target, second],
      planner: (target) => {
        inspected.push(
          target.bytes ? new TextDecoder().decode(target.bytes) : "absent",
        );
        if (target.targetPath === value.target) {
          // This callback cannot change what a later trusted callback receives.
          writeFileSync(second, "changed after all reads");
        }
        return { kind: "unchanged" };
      },
    });
    expect(inspected).toEqual(["absent", "before"]);
    expect(await applyHarnessInstallation(plan)).toMatchObject({
      ok: false,
      state: "conflict",
    });
  });
  it.each([
    "combined-limit",
    "cross-kind-alias",
    "accessor",
    "sparse",
    "entry-accessor",
  ])("rejects %s before any planner callback", async (kind) => {
    const value = await fixture();
    let called = 0;
    const input = {
      manifestPath: value.manifest,
      operation: "install" as const,
      targetPaths: [value.target],
      directoryPaths:
        kind === "cross-kind-alias"
          ? [value.target]
          : Array.from({ length: 16 }, (_, index) =>
              join(value.root, `directory-${index}`),
            ),
      planner: () => {
        called += 1;
        return { kind: "unchanged" as const };
      },
    };
    if (kind === "accessor")
      Object.defineProperty(input, "directoryPaths", {
        get() {
          throw new Error("unread accessor");
        },
      });
    if (kind === "sparse")
      input.directoryPaths = Object.assign(new Array<string>(1), {
        extra: true,
      });
    if (kind === "entry-accessor") {
      input.directoryPaths = [value.target];
      Object.defineProperty(input.directoryPaths, "0", {
        get() {
          throw new Error("unread array entry");
        },
      });
    }
    expect((await inspectHarnessInstallation(input)).disposition).toBe(
      "invalid",
    );
    expect(called).toBe(0);
  });
});
