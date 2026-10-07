import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
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

// Execute the actual private TS observation body with fixed public filesystem
// and native-result fixtures. No native asset is loaded by these unit cases.
const actualFunctions = (file: string, required: readonly string[]) => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = parsed.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          required.includes(declaration.name.text),
      ),
  );
  expect(selected).toHaveLength(required.length);
  return selected.map((statement) => statement.getFullText(parsed)).join("\n");
};
const observationFixture = (raw: unknown, drift = false) => {
  const body = ts.transpileModule(
    actualFunctions("./installation-directory-preimages.ts", [
      "own",
      "digest",
      "typedArrayByteLength",
      "typedArraySet",
      "copyNativeBytes",
      "names",
      "metadataIdentity",
      "inspectDirectoryPreimage",
    ]),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  let closed = 0;
  let stats = 0;
  const status = {
    dev: 1n,
    ino: 2n,
    mode: 0o40700n,
    nlink: 2n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    isDirectory: () => true,
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(body, {
    exports,
    createHash,
    constants,
    types,
    Uint8Array,
    Buffer,
    TextDecoder,
    process: { platform: "linux" },
    join,
    unavailable: () => {
      throw new Error("harness.installation.directory-unavailable");
    },
    nativeObservation: () => Promise.resolve({ __proto__: null, value: raw }),
    open: (_path: string, flags: number) => {
      expect(flags).toBe(
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_DIRECTORY |
          constants.O_NONBLOCK,
      );
      return Promise.resolve({
        fd: 7,
        stat: () =>
          Promise.resolve({ ...status, ino: drift && stats++ > 0 ? 8n : 2n }),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      });
    },
    lstat: () => Promise.resolve(status),
  });
  const inspect = exports.inspectDirectoryPreimage as (
    path: string,
    identity: (path: string) => string,
  ) => Promise<unknown>;
  return {
    inspect: () => inspect("/owned/cache", (path) => path),
    closed: () => closed,
  };
};

describe("actual directory observation body with fixed native-result data", () => {
  it.each([false, true])(
    "bounds bytes before copying (aggregate %s)",
    (aggregate) => {
      const source = actualFunctions("./installation-directory-preimages.ts", [
        "own",
        "typedArrayByteLength",
        "names",
      ]);
      let copies = 0;
      const entries = aggregate
        ? [new Uint8Array(1_048_576).fill(97), new Uint8Array([98])]
        : [new Uint8Array(1_048_577)];
      const body = ts.transpileModule(
        `${source}\nnames(raw, '/owned', p => p);`,
        {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        },
      ).outputText;
      expect(() => {
        runInNewContext(body, {
          types,
          Uint8Array,
          TextDecoder,
          raw: { entries },
          copyNativeBytes: (value: Uint8Array) => {
            copies += 1;
            return value;
          },
          unavailable: () => {
            throw new Error("bounded before copy");
          },
        });
      }).toThrow("bounded before copy");
      expect(copies).toBe(aggregate ? 1 : 0);
    },
  );
  const raw = (entries: unknown) => ({
    dev: 1n,
    ino: 2n,
    mode: 0o40700n,
    entries,
  });
  it("returns sorted copied names and joins the held descriptor", async () => {
    const value = observationFixture(
      raw([new TextEncoder().encode("z"), new TextEncoder().encode("a")]),
    );
    expect(await value.inspect()).toMatchObject({
      exists: true,
      entries: ["a", "z"],
      mode: 0o700,
    });
    expect(value.closed()).toBe(1);
  });
  it.each([
    "identity",
    "invalid-utf8",
    "duplicate",
    "traversal",
    "oversize",
    "proxy",
    "getter",
  ])("refuses %s without leaking the held descriptor", async (kind) => {
    let traps = 0;
    const entries: unknown[] = [new TextEncoder().encode("a")];
    if (kind === "invalid-utf8") entries[0] = new Uint8Array([0xff]);
    if (kind === "duplicate") entries.push(new TextEncoder().encode("a"));
    if (kind === "traversal") entries[0] = new TextEncoder().encode("..");
    if (kind === "oversize") entries[0] = new Uint8Array(1_048_577);
    if (kind === "proxy")
      entries[0] = new Proxy(new Uint8Array([97]), {
        getPrototypeOf() {
          traps += 1;
          throw new Error("unread proxy");
        },
      });
    if (kind === "getter")
      Object.defineProperty(entries, "0", {
        get() {
          traps += 1;
          throw new Error("unread getter");
        },
      });
    const value = observationFixture(raw(entries), kind === "identity");
    await expect(value.inspect()).rejects.toThrow(
      "harness.installation.directory-unavailable",
    );
    expect(value.closed()).toBe(1);
    expect(traps).toBe(0);
  });
});
