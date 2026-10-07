import * as fileSystem from "node:fs";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryMockServerSupplier } from "../mockserver-material/supplier-inventory.mjs";

const roots: string[] = [];
const jar =
  "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar";
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-supplier-inventory-"));
  roots.push(root);
  for (const path of [
    "maven-repository/org/example",
    "npm-cache/_cacache/content-v2/sha512",
    "source/mockserver/mockserver-netty/target",
  ])
    mkdirSync(resolve(root, path), { recursive: true, mode: 0o700 });
  for (const path of [
    "source/mockserver",
    "source/mockserver/mockserver-netty",
  ])
    chmodSync(resolve(root, path), 0o775);
  writeFileSync(resolve(root, jar), "synthetic-jar", { mode: 0o644 });
  writeFileSync(
    resolve(root, "maven-repository/org/example/a.jar"),
    "synthetic-maven",
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(root, "npm-cache/_cacache/content-v2/sha512/aa"),
    "synthetic-npm",
    { mode: 0o644 },
  );
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("supplier cache/JAR observations (not dependency authentication)", () => {
  it("inventories deterministic exact private paths, modes, bytes and hashes", () => {
    const root = fixture();
    const first = inventoryMockServerSupplier(root);
    expect(inventoryMockServerSupplier(root)).toEqual(first);
    const result = JSON.parse(first.toString()) as {
      evidenceScope: string;
      consumedDependencyClosure: string;
      artifact: { sha256: string };
      caches: { type: string }[];
    };
    expect(result.evidenceScope).toBe("untrusted-cache-and-jar-research-only");
    expect(result.consumedDependencyClosure).toBe("not-proved");
    expect(result.artifact).toMatchObject({
      path: jar,
      type: "file",
      bytes: 13,
      mode: 0o644,
    });
    expect(result.artifact.sha256).toMatch(/^[a-f\d]{64}$/u);
    expect(
      result.caches.filter((row: { type: string }) => row.type === "file"),
    ).toHaveLength(2);
    expect(first.length).toBeLessThan(8 * 1024 * 1024);
  });
  it.each(["file", "directory", "ancestor"])(
    "rejects substituted %s symlink",
    (kind) => {
      const root = fixture();
      if (kind === "file")
        symlinkSync(resolve(root, jar), resolve(root, "npm-cache/alias"));
      else if (kind === "directory")
        symlinkSync(
          resolve(root, "npm-cache"),
          resolve(root, "maven-repository/alias"),
        );
      else {
        rmSync(resolve(root, "source"), { recursive: true });
        symlinkSync(resolve(root, "maven-repository"), resolve(root, "source"));
      }
      expect(() => inventoryMockServerSupplier(root)).toThrow(
        "supplier-inventory",
      );
    },
  );
  it("rejects hardlinks, executable cache files and writable directories", () => {
    for (const kind of ["hardlink", "executable", "directory"]) {
      const root = fixture();
      if (kind === "hardlink")
        linkSync(resolve(root, jar), resolve(root, "npm-cache/hardlink"));
      else if (kind === "executable") chmodSync(resolve(root, jar), 0o755);
      else chmodSync(resolve(root, "npm-cache"), 0o777);
      expect(() => inventoryMockServerSupplier(root)).toThrow(
        "supplier-inventory",
      );
    }
  });
  it.each(["source/mockserver", "source/mockserver/mockserver-netty"])(
    "requires the pinned source directory mode only at %s",
    (path) => {
      for (const mode of [0o700, 0o755, 0o777, 0o2775]) {
        const root = fixture();
        chmodSync(resolve(root, path), mode);
        expect(() => inventoryMockServerSupplier(root)).toThrow(
          "supplier-inventory",
        );
      }
    },
  );
  it.each([
    ".",
    "source",
    "source/mockserver/mockserver-netty/target",
    "maven-repository",
    "npm-cache",
  ])("does not admit source mode at generic directory %s", (path) => {
    const root = fixture();
    chmodSync(resolve(root, path), 0o775);
    expect(() => inventoryMockServerSupplier(root)).toThrow(
      "supplier-inventory",
    );
  });
  it("rejects missing caches and absent/empty artifacts", () => {
    for (const missing of ["npm-cache", jar, "empty"]) {
      const root = fixture();
      if (missing === "empty") writeFileSync(resolve(root, jar), "");
      else rmSync(resolve(root, missing), { recursive: true });
      expect(() => inventoryMockServerSupplier(root)).toThrow();
    }
  });
  it("rejects noncanonical paths and unexpected cache names", () => {
    expect(() => inventoryMockServerSupplier("relative")).toThrow(
      "supplier-inventory",
    );
    const root = fixture();
    writeFileSync(resolve(root, "npm-cache/unexpected name"), "x");
    expect(() => inventoryMockServerSupplier(root)).toThrow(
      "supplier-inventory",
    );
  });
  it("bounds depth before traversing deeper descendants", () => {
    const root = fixture();
    mkdirSync(
      resolve(root, "npm-cache", ...Array.from({ length: 34 }, () => "d")),
      { recursive: true, mode: 0o700 },
    );
    expect(() => inventoryMockServerSupplier(root)).toThrow(
      "supplier-inventory",
    );
  });
});
describe("supplier inventory first-failure observations", () => {
  it("does not report a failure on successful inventory", () => {
    const categories: string[] = [];
    expect(
      inventoryMockServerSupplier(fixture(), (category) =>
        categories.push(category),
      ),
    ).toBeInstanceOf(Buffer);
    expect(categories).toEqual([]);
  });
  it.each([false, true])(
    "preserves a non-IO compute failure with sink failure %s",
    (sinkFailure) => {
      const root = fixture();
      const categories: string[] = [];
      let errorReads = 0;
      let closes = 0;
      const primary = new Error("SECRET_CANARY");
      Object.defineProperty(primary, "message", {
        get: () => {
          errorReads += 1;
          throw Error("SECRET_CANARY");
        },
      });
      const body = readFileSync(
        new URL(
          "../mockserver-material/supplier-inventory.mjs",
          import.meta.url,
        ),
        "utf8",
      )
        .replace(/import[\s\S]*?from "node:[^"]+";/gu, "")
        .replace(
          "export const inventoryMockServerSupplier",
          "const inventoryMockServerSupplier",
        );
      const result: unknown = runInNewContext(
        `${body}\n(() => { try { inventoryMockServerSupplier(root, observer); } catch (error) { return error; } })();`,
        {
          ...fileSystem,
          resolve,
          root,
          Buffer,
          process,
          createHash: () => {
            throw primary;
          },
          closeSync: (fd: number) => {
            closes += 1;
            fileSystem.closeSync(fd);
          },
          observer: (category: string) => {
            categories.push(category);
            if (sinkFailure) throw Error("SINK_CANARY");
          },
        },
      );
      expect(result).toBe(primary);
      expect(categories).toEqual(["inventory-internal"]);
      expect(categories.join("")).not.toContain("CANARY");
      expect(errorReads).toBe(0);
      expect(closes).toBe(1);
    },
  );
  it("reports only the first fixed guard category and preserves refusal with a throwing sink", () => {
    const categories: string[] = [];
    const sink = new Error("SECRET_CANARY");
    expect(() =>
      inventoryMockServerSupplier("relative", (category: string) => {
        categories.push(category);
        throw sink;
      }),
    ).toThrow("integration.mockserver-material.supplier-inventory");
    expect(categories).toEqual(["inventory-guard"]);
  });
  it("reports a filesystem read failure without reading or replacing its error", () => {
    const root = fixture();
    const categories: string[] = [];
    const primary = new Error("SECRET_CANARY");
    const body = readFileSync(
      new URL("../mockserver-material/supplier-inventory.mjs", import.meta.url),
      "utf8",
    )
      .replace(/import[\s\S]*?from "node:[^"]+";/gu, "")
      .replace(
        "export const inventoryMockServerSupplier",
        "const inventoryMockServerSupplier",
      );
    const result: unknown = runInNewContext(
      `${body}\n(() => { try { inventoryMockServerSupplier(root, observer); } catch (error) { return error; } })();`,
      {
        ...fileSystem,
        createHash,
        resolve,
        root,
        Buffer,
        process,
        lstatSync: () => {
          throw primary;
        },
        observer: (category: string) => {
          categories.push(category);
          throw Error("SINK_CANARY");
        },
      },
    );
    expect(result).toBe(primary);
    expect(categories).toEqual(["inventory-read"]);
  });
});
describe("supplier inventory byte bounds", () => {
  it("reads at most the remaining entry budget plus one and closes before rejection", () => {
    const root = fixture();
    const body = readFileSync(
      new URL("../mockserver-material/supplier-inventory.mjs", import.meta.url),
      "utf8",
    )
      .replace(/import[\s\S]*?from "node:[^"]+";/gu, "")
      .replace(
        "export const inventoryMockServerSupplier",
        "const inventoryMockServerSupplier",
      );
    let reads = 0;
    let closed = false;
    const io = {
      ...fileSystem,
      opendirSync: (_path: string, options: { bufferSize: number }) => {
        expect(options.bufferSize).toBe(1);
        return {
          readSync: () => ({ name: `entry-${++reads}` }),
          closeSync: () => {
            closed = true;
          },
        };
      },
    };
    expect(() => {
      runInNewContext(`${body}\ninventoryMockServerSupplier(root);`, {
        ...io,
        createHash,
        resolve,
        root,
        Buffer,
        process,
      });
    }).toThrow("supplier-inventory");
    expect(reads).toBe(16_384);
    expect(closed).toBe(true);
  });
  it("rejects a sparse over-ceiling file before reading its body", () => {
    const root = fixture();
    truncateSync(resolve(root, jar), 256 * 1024 * 1024 + 1);
    expect(() => inventoryMockServerSupplier(root)).toThrow(
      "supplier-inventory",
    );
  });
  it("bounds a growing real file to its admitted body plus one rejection byte", () => {
    const root = fixture();
    const body = readFileSync(
      new URL("../mockserver-material/supplier-inventory.mjs", import.meta.url),
      "utf8",
    )
      .replace(/import[\s\S]*?from "node:[^"]+";/gu, "")
      .replace(
        "export const inventoryMockServerSupplier",
        "const inventoryMockServerSupplier",
      );
    let reads = 0;
    let consumed = 0;
    const io = {
      ...fileSystem,
      readSync: (...args: Parameters<typeof fileSystem.readSync>) => {
        if (++reads === 1)
          writeFileSync(
            resolve(root, "maven-repository/org/example/a.jar"),
            Buffer.alloc(128 * 1024),
            { flag: "a" },
          );
        const count = fileSystem.readSync(...args);
        consumed += count;
        return count;
      },
    };
    expect(() => {
      runInNewContext(`${body}\ninventoryMockServerSupplier(root);`, {
        ...io,
        createHash,
        resolve,
        root,
        Buffer,
        process,
      });
    }).toThrow("supplier-inventory");
    expect(consumed).toBe(16); // admitted synthetic-maven length 15 + one probe
  });
});
