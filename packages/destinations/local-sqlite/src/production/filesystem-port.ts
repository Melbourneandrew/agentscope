/* eslint-disable max-lines-per-function -- one closed filesystem-port object keeps namespace operations under the same owned root. */
import { createHash, randomBytes } from "node:crypto";
import { fchmodSync, fsyncSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { LocalSqliteLifecycleGatePort } from "../lifecycle/fence.js";
import {
  boundedOwnedNames,
  createPathAtomicExchangeForTesting,
  linkOwnedFile,
  openOwnedDirectory,
  readOwnedUtf8,
  removeOwnedFile,
  replaceOwnedFile,
  statOwnedFile,
  writeOwnedExclusive,
  type OwnedAtomicExchange,
} from "./owned-filesystem.js";

const maximumArtifactBytes = 65_536;
const maximumEntries = 192;
const lifecycleName =
  /^(?:exclusive-fence-v1|intent-v1\.json|operation-phase-v1\.json|ownership-receipt-v1\.json|lease-[a-f0-9]{32}\.json|lease-cleanup-[a-f0-9]{32}\.json)$/u;

const exactLifecycleName = (filename: string): string => {
  if (!lifecycleName.test(filename) || basename(filename) !== filename)
    throw new Error("destination.local-sqlite.filesystem.invalid");
  return filename;
};

const writeExclusive = (
  directory: string,
  filename: string,
  content: string,
  allowPathFallbackForTesting: boolean,
): Readonly<{ state: "created"; physicalIdentity: string }> => {
  if (Buffer.byteLength(content, "utf8") > maximumArtifactBytes)
    throw new Error("destination.local-sqlite.filesystem.invalid");
  const owned = openOwnedDirectory(directory, allowPathFallbackForTesting);
  try {
    const evidence = writeOwnedExclusive(
      owned,
      exactLifecycleName(filename),
      Buffer.from(content, "utf8"),
      maximumArtifactBytes,
    );
    return Object.freeze({
      state: "created",
      physicalIdentity: evidence.physicalIdentity,
    });
  } finally {
    owned.close();
  }
};

/* v8 ignore start -- this /proc parser is Linux-only and is executed by the
   exact Linux native/packed gate; macOS source coverage exercises the fallback. */
const readStartTicks = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    const fields = value.slice(close + 2).split(" ");
    const ticks = fields[19];
    return ticks === undefined
      ? undefined
      : createHash("sha256")
          .update(`${pid}:${ticks}`)
          .digest("hex")
          .slice(0, 32);
  } catch {
    return undefined;
  }
};
/* v8 ignore stop */

export const processStartIdentity = (pid: number): string | undefined =>
  readStartTicks(pid);

export const currentProcessStartIdentity = (): string =>
  processStartIdentity(process.pid) ??
  createHash("sha256")
    .update(`${process.pid}:${process.uptime()}`)
    .digest("hex")
    .slice(0, 32);

export const ensurePrivateDirectory = (
  path: string,
  options: Readonly<{
    allowPathFallbackForTesting?: boolean;
    afterIdentityCheckForTesting?: () => void;
  }> = {},
): void => {
  const allowPathFallbackForTesting =
    options.allowPathFallbackForTesting === true;
  const parent = openOwnedDirectory(dirname(path), allowPathFallbackForTesting);
  try {
    try {
      mkdirSync(join(parent.relativeRoot, basename(path)), {
        recursive: false,
        mode: 0o700,
      });
      fsyncSync(parent.descriptor);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    const child = openOwnedDirectory(
      join(parent.relativeRoot, basename(path)),
      allowPathFallbackForTesting,
    );
    try {
      /* v8 ignore next -- Windows is not part of this currently admitted
         native tuple; its no-fchmod branch remains fail-closed by later checks. */
      if (process.platform !== "win32") fchmodSync(child.descriptor, 0o700);
      child.assertCurrent();
      parent.assertCurrent();
      options.afterIdentityCheckForTesting?.();
      const canonical = openOwnedDirectory(path, allowPathFallbackForTesting);
      try {
        if (
          canonical.device !== child.device ||
          canonical.inode !== child.inode
        )
          throw new Error("destination.local-sqlite.filesystem.raced");
      } finally {
        canonical.close();
      }
    } finally {
      child.close();
    }
  } finally {
    parent.close();
  }
};

export const createLocalSqliteFilesystemGatePort = (
  lifecycleDirectory: string,
  options: Readonly<{
    allowPathFallbackForTesting?: boolean;
    atomicExchange?: OwnedAtomicExchange | undefined;
  }> = {},
): LocalSqliteLifecycleGatePort => {
  const allowPathFallbackForTesting =
    options.allowPathFallbackForTesting === true;
  /* v8 ignore start -- source tests exercise the explicit path exchange and
     the Linux candidate gate exercises the native exchange; production
     construction without either is rejected before mutation. */
  const atomicExchange: OwnedAtomicExchange | undefined =
    options.atomicExchange ??
    (allowPathFallbackForTesting
      ? createPathAtomicExchangeForTesting(lifecycleDirectory)
      : undefined);
  /* v8 ignore stop */
  const list = () => {
    const owned = openOwnedDirectory(
      lifecycleDirectory,
      allowPathFallbackForTesting,
    );
    try {
      const names = boundedOwnedNames(owned, maximumEntries);
      return Object.freeze({
        entries: Object.freeze(
          names.map((name) => {
            const evidence = statOwnedFile(
              owned,
              exactLifecycleName(name),
              maximumArtifactBytes,
            );
            return Object.freeze({
              name,
              bytes: evidence.bytes,
              physicalIdentity: evidence.physicalIdentity,
            });
          }),
        ),
      });
    } finally {
      owned.close();
    }
  };
  return Object.freeze({
    classifyOwner: ({ owner }) => {
      /* v8 ignore next -- Linux owner classification is exercised by the
         exact Linux native/packed gate; macOS admits only indeterminate. */
      if (process.platform !== "linux")
        return Object.freeze({ state: "indeterminate" });
      /* v8 ignore start -- Linux /proc and kill(0) ownership outcomes are
         exercised in the exact Linux gate and conditional source matrix. */
      const observed = readStartTicks(owner.pid);
      if (observed === undefined) {
        try {
          process.kill(owner.pid, 0);
          return Object.freeze({ state: "indeterminate" });
        } catch {
          return Object.freeze({ state: "dead" });
        }
      }
      return Object.freeze({
        state: observed === owner.startIdentity ? "live" : "dead",
      });
      /* v8 ignore stop */
    },
    createFenceDurably: ({ filename, content }) => {
      try {
        return writeExclusive(
          lifecycleDirectory,
          filename,
          content,
          allowPathFallbackForTesting,
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return Object.freeze({ state: "exists" });
        throw error;
      }
    },
    createLeaseDurably: ({ filename, content }) => {
      try {
        return writeExclusive(
          lifecycleDirectory,
          filename,
          content,
          allowPathFallbackForTesting,
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return Object.freeze({ state: "exists" });
        throw error;
      }
    },
    createLeaseCleanupClaim: ({
      cleanupClaimName,
      leaseName,
      leasePhysicalIdentity,
    }) => {
      const owned = openOwnedDirectory(
        lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        const linked = linkOwnedFile(
          owned,
          exactLifecycleName(leaseName),
          exactLifecycleName(cleanupClaimName),
          leasePhysicalIdentity,
        );
        return Object.freeze({
          state: "created",
          physicalIdentity: linked.physicalIdentity,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return Object.freeze({ state: "exists" });
        throw error;
      } finally {
        owned.close();
      }
    },
    listLifecycle: list,
    readArtifact: ({ filename }) => {
      const owned = openOwnedDirectory(
        lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        const read = readOwnedUtf8(
          owned,
          exactLifecycleName(filename),
          maximumArtifactBytes,
          false,
        );
        return Object.freeze({
          state: "present",
          physicalIdentity: read.evidence.physicalIdentity,
          content: read.content,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return Object.freeze({ state: "absent" });
        throw error;
      } finally {
        owned.close();
      }
    },
    removeArtifactIfIdentity: ({ filename, physicalIdentity: expected }) => {
      const owned = openOwnedDirectory(
        lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        return Object.freeze({
          state: removeOwnedFile(owned, exactLifecycleName(filename), expected),
        });
      } finally {
        owned.close();
      }
    },
    replaceLeaseDurably: ({
      filename,
      physicalIdentity: expected,
      content,
    }) => {
      const temporaryName = `lease-${randomBytes(16).toString("hex")}.json`;
      const owned = openOwnedDirectory(
        lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        const current = statOwnedFile(
          owned,
          exactLifecycleName(filename),
          maximumArtifactBytes,
        );
        if (current.physicalIdentity !== expected)
          return Object.freeze({ state: "mismatch" });
        const temporary = writeOwnedExclusive(
          owned,
          temporaryName,
          Buffer.from(content, "utf8"),
          maximumArtifactBytes,
        );
        /* v8 ignore next -- source tests use the explicit path exchange;
           production absence is rejected by the Linux native artifact gate. */
        if (atomicExchange === undefined)
          throw new Error("destination.local-sqlite.native-unavailable");
        const replaced = replaceOwnedFile(
          owned,
          temporaryName,
          exactLifecycleName(filename),
          temporary.physicalIdentity,
          expected,
          atomicExchange,
        );
        return Object.freeze({
          state: "replaced",
          physicalIdentity: replaced.physicalIdentity,
        });
      } finally {
        removeOwnedFile(owned, temporaryName);
        owned.close();
      }
    },
  });
};
