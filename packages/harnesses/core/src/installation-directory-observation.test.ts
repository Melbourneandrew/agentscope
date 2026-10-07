import { mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import {
  chmodSync,
  constants,
  fstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as directoryPreimages from "./installation-directory-preimages.js";

const roots: string[] = [];
// Vite's source-root URL for the fixed runtime-only asset (absent until emit).
const loaderPath = "/src/directory-runtime/loader/owned-loader.mjs";
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
  vi.unstubAllGlobals();
  vi.doUnmock(loaderPath);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("fixed loader namespace and untrusted native data", () => {
  it("observes a present directory through the standard mocked namespace", async () => {
    const { root } = await fixture();
    const status = await lstat(root, { bigint: true });
    const observe = vi.fn(() => ({
      dev: status.dev,
      ino: status.ino,
      mode: status.mode,
      entries: [new TextEncoder().encode("z"), new TextEncoder().encode("a")],
    }));
    const load = vi.fn(() => ({ observeDirectory: observe }));
    vi.stubGlobal("__AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__", "a".repeat(64));
    vi.doMock(loaderPath, () => ({ loadDirectoryPrimitive: load }));
    const namespace: unknown = await import(loaderPath);
    expect(
      Object.getOwnPropertyDescriptor(namespace, "loadDirectoryPrimitive")
        ?.value,
    ).toBe(load);
    const result = await directoryPreimages
      .inspectDirectoryPreimage(root, (p) => p)
      .catch(() => null);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith("a".repeat(64));
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]).toHaveLength(1);
    expect(result?.entries).toEqual(["a", "z"]);
  });
  it.each([
    "missing",
    "nonfunction",
    "getter",
    "proxy",
    "loader-then",
    "raw-getter",
    "observer-proxy",
    "observer-then",
  ])(
    "refuses malformed %s without invoking untrusted accessors",
    async (kind) => {
      const { root } = await fixture();
      let traps = 0;
      const getter = () => {
        traps += 1;
        throw new Error("unread secret");
      };
      const exports: Record<string, unknown> = {};
      const then = () => Object.defineProperty({}, "then", { get: getter });
      const observe = vi.fn(() =>
        kind === "observer-proxy"
          ? new Proxy({}, { get: getter })
          : kind === "observer-then"
            ? then()
            : Object.defineProperty({}, "entries", { get: getter }),
      );
      const load = vi.fn(() =>
        kind === "proxy"
          ? new Proxy({}, { get: getter })
          : kind === "loader-then"
            ? then()
            : { observeDirectory: observe },
      );
      if (kind === "nonfunction") exports.loadDirectoryPrimitive = 1;
      if (kind === "getter")
        Object.defineProperty(exports, "loadDirectoryPrimitive", {
          get: getter,
        });
      const loadExpected = !["missing", "nonfunction", "getter"].includes(kind);
      if (loadExpected) exports.loadDirectoryPrimitive = load;
      vi.doMock(loaderPath, () => exports);
      const namespace: unknown = await import(loaderPath);
      const descriptor = Object.getOwnPropertyDescriptor(
        namespace,
        "loadDirectoryPrimitive",
      );
      if (kind === "getter")
        expect(Object.getOwnPropertyDescriptor(descriptor, "get")?.value).toBe(
          getter,
        );
      else expect(descriptor?.value).toBe(exports.loadDirectoryPrimitive);
      await expect(
        directoryPreimages.inspectDirectoryPreimage(root, (p) => p),
      ).rejects.toThrow("harness.installation.directory-unavailable");
      expect(traps).toBe(0);
      expect(load).toHaveBeenCalledTimes(loadExpected ? 1 : 0);
      expect(observe).toHaveBeenCalledTimes(
        kind === "raw-getter" || kind.startsWith("observer-") ? 1 : 0,
      );
    },
  );
});

describe("instrumented native bytes and I/O boundaries", () => {
  it("refuses an unexpected non-directory handle and closes it", async () => {
    const { root } = await fixture();
    const handle = await filesystem.open(join(root, "regular-file"), "w+");
    const fd = handle.fd;
    try {
      vi.doMock("node:fs/promises", () => ({
        ...filesystem,
        open: () => Promise.resolve(handle),
      }));
      vi.resetModules();
      const actualModule =
        await import("./installation-directory-preimages.js");
      await expect(
        actualModule.inspectDirectoryPreimage(root, (p) => p),
      ).rejects.toThrow("harness.installation.directory-unavailable");
      expect(() => fstatSync(fd)).toThrow();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await handle.close();
    }
  });
  it.each(["win32", "linux"])(
    "checks the synthetic %s platform boundary",
    async (platform) => {
      const { root } = await fixture();
      const status = await lstat(root, { bigint: true });
      const prior = Object.getOwnPropertyDescriptor(process, "platform")!;
      const load = vi.fn(() => ({
        observeDirectory: () => ({
          dev: status.dev,
          ino: status.ino,
          mode: status.mode,
          entries: [],
        }),
      }));
      vi.doMock(loaderPath, () => ({ loadDirectoryPrimitive: load }));
      try {
        Object.defineProperty(process, "platform", {
          ...prior,
          value: platform,
        });
        const result = directoryPreimages.inspectDirectoryPreimage(
          root,
          (p) => p,
        );
        if (platform === "win32") {
          await expect(result).rejects.toThrow(
            "harness.installation.directory-unavailable",
          );
          expect(load).not.toHaveBeenCalled();
        } else {
          expect((await result).entries).toEqual([]);
          expect(load).toHaveBeenCalledOnce();
        }
      } finally {
        Object.defineProperty(process, "platform", prior);
      }
    },
  );
  it.each(["constructor", "byteLength", "iterator"])(
    "copies native bytes without consulting an own %s accessor",
    async (kind) => {
      const { root } = await fixture();
      const status = await lstat(root, { bigint: true });
      const bytes = new Uint8Array([97]);
      let calls = 0;
      Object.defineProperty(
        bytes,
        kind === "iterator" ? Symbol.iterator : kind,
        {
          get() {
            calls += 1;
            throw new Error("unread accessor");
          },
        },
      );
      const observe = vi.fn(() => ({
        dev: status.dev,
        ino: status.ino,
        mode: status.mode,
        entries: [bytes],
      }));
      vi.doMock(loaderPath, () => ({
        loadDirectoryPrimitive: () => ({ observeDirectory: observe }),
      }));
      expect(
        (await directoryPreimages.inspectDirectoryPreimage(root, (p) => p))
          .entries,
      ).toEqual(["a"]);
      expect(observe).toHaveBeenCalledOnce();
      expect(calls).toBe(0);
    },
  );
});

describe("instrumented production observation refusals", () => {
  it.each([
    "count",
    "keys",
    "entry-proxy",
    "entry-type",
    "entry-prototype",
    "bytes",
    "empty",
    "dot",
    "parent",
    "separator",
    "encoding",
    "alias",
    "dev",
    "ino",
    "mode",
    "held-drift",
  ])(
    "refuses %s through the real module and closes its descriptor",
    async (kind) => {
      const { root } = await fixture();
      const status = await lstat(root, { bigint: true });
      const encode = (name: string) => new TextEncoder().encode(name);
      const rows: Record<string, unknown> = {
        count: Array.from({ length: 1025 }, () => encode("a")),
        keys: Object.assign([encode("a")], { extra: true }),
        "entry-proxy": [new Proxy(encode("a"), {})],
        "entry-type": ["a"],
        "entry-prototype": [new (class extends Uint8Array {})(1)],
        bytes: [new Uint8Array(1_048_577)],
        empty: [new Uint8Array()],
        dot: [encode(".")],
        parent: [encode("..")],
        separator: [encode("a/b")],
        encoding: [new Uint8Array([255])],
        alias: [encode("a"), encode("a")],
      };
      let fd = -1;
      const observe = vi.fn((descriptor: number) => {
        fd = descriptor;
        if (kind === "held-drift") chmodSync(root, 0o755);
        return {
          dev: status.dev,
          ino: status.ino,
          mode: status.mode,
          entries: rows[kind] ?? [encode("a")],
          ...(["dev", "ino", "mode"].includes(kind) ? { [kind]: 0n } : {}),
        };
      });
      vi.doMock(loaderPath, () => ({
        loadDirectoryPrimitive: () => ({ observeDirectory: observe }),
      }));
      await expect(
        directoryPreimages.inspectDirectoryPreimage(root, (p) => p),
      ).rejects.toThrow("harness.installation.directory-unavailable");
      expect(observe).toHaveBeenCalledOnce();
      expect(() => fstatSync(fd)).toThrow();
    },
  );
  it("refuses an ancestor replacement even when the held child stays stable", async () => {
    const { root } = await fixture();
    const parent = join(root, "parent");
    const directory = join(parent, "cache");
    mkdirSync(directory, { recursive: true });
    const before = await lstat(directory, { bigint: true });
    const observe = vi.fn(() => {
      renameSync(parent, join(root, "previous"));
      mkdirSync(directory, { recursive: true });
      return {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        entries: [],
      };
    });
    vi.doMock(loaderPath, () => ({
      loadDirectoryPrimitive: () => ({ observeDirectory: observe }),
    }));
    await expect(
      directoryPreimages.inspectDirectoryPreimage(directory, (p) => p),
    ).rejects.toThrow("harness.installation.directory-unavailable");
    expect(observe).toHaveBeenCalledOnce();
  });
});

describe("private async envelope prototype", () => {
  it("does not consult an ambient then getter while returning native data", async () => {
    const { root } = await fixture();
    const status = await lstat(root, { bigint: true });
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "then");
    const restore = () => {
      if (prior) Object.defineProperty(Object.prototype, "then", prior);
      else Reflect.deleteProperty(Object.prototype, "then");
    };
    let traps = 0;
    const observe = vi.fn(() => {
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          traps += 1;
          return undefined;
        },
      });
      queueMicrotask(restore);
      return {
        dev: status.dev,
        ino: status.ino,
        mode: status.mode,
        entries: [],
      };
    });
    vi.doMock(loaderPath, () => ({
      loadDirectoryPrimitive: () => ({ observeDirectory: observe }),
    }));
    try {
      expect(
        (await directoryPreimages.inspectDirectoryPreimage(root, (p) => p))
          .entries,
      ).toEqual([]);
      expect(observe).toHaveBeenCalledOnce();
      expect(traps).toBe(0);
    } finally {
      restore();
    }
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
