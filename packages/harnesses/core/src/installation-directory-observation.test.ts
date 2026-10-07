import { mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { chmodSync, fstatSync, mkdirSync, renameSync } from "node:fs";
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
      entries: ["z", "a", "\ufeffa"].map((name) =>
        new TextEncoder().encode(name),
      ),
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
    expect(result?.entries).toEqual(["a", "z", "\ufeffa"]);
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
