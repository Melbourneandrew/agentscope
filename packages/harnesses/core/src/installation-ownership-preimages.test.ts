import { fstatSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as files from "./installation-preimages.js";
import * as directories from "./installation-directory-preimages.js";
import type { HarnessTargetInspection } from "./installation-input.js";
import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
} from "./installation.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
const loaderPath = "/src/directory-runtime/loader/owned-loader.mjs";
const encode = (value: string) => new TextEncoder().encode(value);
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-ownership-preimages-")),
  );
  roots.push(root);
  const target = join(root, "settings.json");
  await writeFile(target, "before", { mode: 0o600 });
  return { root, target, manifest: join(root, "transaction.json") };
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.open).mockReset().mockImplementation(originalOpen);
  vi.unstubAllGlobals();
  vi.doUnmock(loaderPath);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("held ownership metadata remains an ephemeral plan precondition", () => {
  it("projects the actual held regular-file UID and inspected absence", async () => {
    const { root, target } = await fixture();
    const invalid = () => {
      throw new Error("invalid");
    };
    const present = await files.inspectInstallationPreimage(target, invalid);
    expect(present.uid).toBe(
      process.platform === "linux" || process.platform === "darwin"
        ? (await stat(target)).uid
        : null,
    );
    expect(
      (await files.inspectInstallationPreimage(join(root, "absent"), invalid))
        .uid,
    ).toBeNull();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    "refuses malformed held UID %s and closes the held file",
    async (uid) => {
      const { target } = await fixture();
      const handle = await originalOpen(target, "r");
      const metadata = await handle.stat();
      const close = vi.spyOn(handle, "close");
      const read = vi.spyOn(handle, "read");
      vi.spyOn(handle, "stat").mockResolvedValue(
        Object.assign(metadata, { uid }),
      );
      vi.spyOn(filesystem, "open").mockResolvedValue(handle);
      await expect(
        files.inspectInstallationPreimage(target, () => {
          throw new Error("invalid");
        }),
      ).rejects.toThrow("invalid");
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("refuses ownership changing during the held file read", async () => {
    const { target } = await fixture();
    const handle = await originalOpen(target, "r");
    const before = await handle.stat();
    const after = await handle.stat();
    const close = vi.spyOn(handle, "close");
    vi.spyOn(handle, "stat")
      .mockResolvedValueOnce(Object.assign(before, { uid: 501 }))
      .mockResolvedValueOnce(Object.assign(after, { uid: 502 }));
    vi.spyOn(filesystem, "open").mockResolvedValue(handle);
    await expect(
      files.inspectInstallationPreimage(target, () => {
        throw new Error("invalid");
      }),
    ).rejects.toThrow("invalid");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["win32", "freebsd"])(
    "does not assert POSIX ownership on synthetic %s metadata",
    async (platform) => {
      const { target } = await fixture();
      const prior = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", {
          ...prior,
          value: platform,
        });
        const inspected = await files.inspectInstallationPreimage(
          target,
          () => {
            throw new Error("invalid");
          },
        );
        expect(inspected.uid).toBeNull();
        expect(inspected.exists).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", prior);
      }
    },
  );
});

describe("held directory ownership metadata", () => {
  it("projects UID from the held directory, not the primitive DTO", async () => {
    const { root } = await fixture();
    vi.stubGlobal("__AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__", "a".repeat(64));
    vi.doMock(loaderPath, () => ({
      loadDirectoryPrimitive: () => ({
        observeDirectory: (fd: number) => {
          const held = fstatSync(fd, { bigint: true });
          return {
            dev: held.dev,
            ino: held.ino,
            mode: held.mode,
            uid: -1,
            entries: [encode("settings.json")],
          };
        },
      }),
    }));
    const observed = await directories.inspectDirectoryPreimage(root, (p) => p);
    expect(observed.uid).toBe((await stat(root)).uid);
    const projected = directories.directoryInspection([observed]);
    expect(projected[0]?.uid).toBe(observed.uid);
    expect(Object.isFrozen(projected[0])).toBe(true);
  });

  it.each(["negative", "oversafe", "held-drift"])(
    "refuses %s directory UID metadata and closes the held descriptor",
    async (kind) => {
      const { root } = await fixture();
      const handle = await originalOpen(root, "r");
      const before = await handle.stat({ bigint: true });
      const after = await handle.stat({ bigint: true });
      const close = vi.spyOn(handle, "close");
      vi.spyOn(handle, "stat")
        .mockResolvedValueOnce(
          Object.assign(before, {
            uid:
              kind === "negative"
                ? -1n
                : kind === "oversafe"
                  ? 9_007_199_254_740_992n
                  : before.uid,
          }),
        )
        .mockResolvedValueOnce(Object.assign(after, { uid: after.uid + 1n }));
      vi.mocked(filesystem.open).mockResolvedValue(handle);
      const observe = vi.fn((fd: number) => {
        const held = fstatSync(fd, { bigint: true });
        return { dev: held.dev, ino: held.ino, mode: held.mode, entries: [] };
      });
      vi.doMock(loaderPath, () => ({
        loadDirectoryPrimitive: () => ({ observeDirectory: observe }),
      }));
      await expect(
        directories.inspectDirectoryPreimage(root, (p) => p),
      ).rejects.toThrow("harness.installation.directory-unavailable");
      expect(observe).toHaveBeenCalledTimes(kind === "held-drift" ? 1 : 0);
      expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe("same-plan ownership comparison", () => {
  it("does not fabricate ownership for a legacy optional-metadata fixture", () => {
    const legacy = {
      directoryPath: "/legacy",
      exists: true,
      mode: 0o700,
      entries: Object.freeze([] as string[]),
      digest: "legacy",
      identity: "legacy",
    };
    expect(directories.directoryInspection([legacy])[0]).not.toHaveProperty(
      "uid",
    );
    expect(
      directories.directoryPreimageMatches(legacy, { ...legacy, uid: 0 }),
    ).toBe(false);
  });

  it.each([undefined, 0, 501])(
    "retains UID %s in fresh frozen planner data",
    async (uid) => {
      const value = await fixture();
      const before = await files.inspectInstallationPreimage(
        value.target,
        () => {
          throw new Error("invalid");
        },
      );
      const legacy = {
        exists: before.exists,
        bytes: before.bytes,
        digest: before.digest,
        mode: before.mode,
      };
      vi.spyOn(files, "inspectInstallationPreimage").mockImplementation(
        async (path, invalid) =>
          path === value.target
            ? uid === undefined
              ? legacy
              : { ...before, uid }
            : originalInspect(path, invalid),
      );
      const planner = vi.fn((target: HarnessTargetInspection) => {
        expect(target.uid).toBe(uid);
        if (uid === undefined) expect(target).not.toHaveProperty("uid");
        expect(Object.isFrozen(target)).toBe(true);
        return { kind: "unchanged" as const };
      });
      const plan = await inspectHarnessInstallation({
        manifestPath: value.manifest,
        operation: "install",
        targetPaths: [value.target],
        planner,
      });
      expect(planner).toHaveBeenCalledOnce();
      expect((await applyHarnessInstallation(plan)).state).toBe("unchanged");
      expect(plan).not.toHaveProperty("uid");
    },
  );
});

describe("UID-only preimage drift refuses all mutation", () => {
  it.each([true, false])(
    "refuses a file UID-only change before mutation=%s",
    async (mutation) => {
      const value = await fixture();
      const original = await originalInspect(value.target, () => {
        throw new Error("invalid");
      });
      let uid = 501;
      vi.spyOn(files, "inspectInstallationPreimage").mockImplementation(
        async (path, invalid) =>
          path === value.target
            ? { ...original, uid }
            : originalInspect(path, invalid),
      );
      const plan = await inspectHarnessInstallation({
        manifestPath: value.manifest,
        operation: "install",
        targetPaths: [value.target],
        planner: () =>
          mutation
            ? { kind: "replace", bytes: encode("after") }
            : { kind: "unchanged" },
      });
      expect(plan.disposition).toBe(mutation ? "ready" : "unchanged");
      uid = 502;
      expect(await applyHarnessInstallation(plan)).toEqual({
        ok: false,
        state: "conflict",
        changedTargetCount: 0,
      });
      expect(await readFile(value.target, "utf8")).toBe("before");
      await expect(readFile(value.manifest)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
    },
  );

  it.each([true, false])(
    "refuses a directory UID-only change before mutation=%s",
    async (mutation) => {
      const value = await fixture();
      const before = {
        directoryPath: value.root,
        exists: true,
        mode: 0o700,
        uid: 501,
        entries: Object.freeze(["settings.json"]),
        digest: "same",
        identity: "same",
      };
      vi.spyOn(directories, "inspectDirectoryPreimage")
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce({ ...before, uid: 502 });
      const plan = await inspectHarnessInstallation({
        manifestPath: value.manifest,
        operation: "install",
        targetPaths: [value.target],
        directoryPaths: [value.root],
        planner: (_target, observed) => {
          expect(observed?.[0]?.uid).toBe(501);
          return mutation
            ? { kind: "replace", bytes: encode("after") }
            : { kind: "unchanged" };
        },
      });
      expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
      expect(await readFile(value.target, "utf8")).toBe("before");
      await expect(readFile(value.manifest)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

const originalInspect = files.inspectInstallationPreimage;
const originalOpen = (
  await vi.importActual<typeof filesystem>("node:fs/promises")
).open;
