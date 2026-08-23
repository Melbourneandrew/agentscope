import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  boundedOwnedNames,
  createPathAtomicExchangeForTesting,
  createOwnedExclusiveFile,
  inspectOwnedSqliteFamily,
  linkOwnedFile,
  LocalSqliteOwnedFilesystemError,
  openOwnedDirectory,
  openOwnedFile,
  readOwnedPrefix,
  readOwnedUtf8,
  removeOwnedFile,
  renameOwnedFile,
  replaceOwnedFile,
  statOwnedFile,
  syncOwnedDirectory,
  syncOwnedFile,
  writeOwnedExclusive,
  type OwnedAtomicExchange,
} from "./owned-filesystem.js";

const guardedPathExchange = (root: string): OwnedAtomicExchange => {
  const exchange = createPathAtomicExchangeForTesting(root);
  return (
    descriptor,
    {
      sourceName,
      destinationName,
      sourceDevice,
      sourceInode,
      destinationDevice,
      destinationInode,
    },
  ) => {
    const source = lstatSync(join(root, sourceName), { bigint: true });
    const destination = lstatSync(join(root, destinationName), {
      bigint: true,
    });
    if (
      source.dev.toString() !== sourceDevice ||
      source.ino.toString() !== sourceInode ||
      destination.dev.toString() !== destinationDevice ||
      destination.ino.toString() !== destinationInode
    )
      return "mismatch";
    return exchange(descriptor, {
      sourceName,
      destinationName,
      sourceDevice,
      sourceInode,
      destinationDevice,
      destinationInode,
    });
  };
};

/* eslint-disable max-lines-per-function -- the integration case keeps the retained directory authority and its whole operation sequence adjacent. */
describe("owned Local SQLite filesystem authority", () => {
  it("admits only the exact bounded SQLite main/WAL/SHM family", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-family-"));
    chmodSync(root, 0o700);
    const directory = openOwnedDirectory(root, true);
    try {
      writeFileSync(join(root, "traces.sqlite"), "main", { mode: 0o600 });
      expect(inspectOwnedSqliteFamily(directory, "traces.sqlite", 16)).toEqual([
        expect.objectContaining({ name: "traces.sqlite" }),
      ]);
      writeFileSync(join(root, "traces.sqlite-wal"), "wal", { mode: 0o600 });
      writeFileSync(join(root, "traces.sqlite-shm"), "shm", { mode: 0o600 });
      expect(
        inspectOwnedSqliteFamily(directory, "traces.sqlite", 16).map(
          ({ name }) => name,
        ),
      ).toEqual(["traces.sqlite", "traces.sqlite-shm", "traces.sqlite-wal"]);
      writeFileSync(join(root, "traces.sqlite-journal"), "journal", {
        mode: 0o600,
      });
      expect(() =>
        inspectOwnedSqliteFamily(directory, "traces.sqlite", 16),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      rmSync(join(root, "traces.sqlite-journal"));
      rmSync(join(root, "traces.sqlite-wal"));
      symlinkSync(join(root, "traces.sqlite"), join(root, "traces.sqlite-wal"));
      expect(() =>
        inspectOwnedSqliteFamily(directory, "traces.sqlite", 16),
      ).toThrow(LocalSqliteOwnedFilesystemError);
    } finally {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("performs only bounded identity-checked operations under retained directories", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-fs-"));
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    chmodSync(root, 0o700);
    mkdirSync(firstPath, { mode: 0o700 });
    mkdirSync(secondPath, { mode: 0o700 });
    const first = openOwnedDirectory(firstPath, true);
    const second = openOwnedDirectory(secondPath, true);
    try {
      expect(first.currentUserOnly).toBe(true);
      first.assertCurrent();
      const alpha = writeOwnedExclusive(
        first,
        "alpha",
        Buffer.from("alpha", "utf8"),
        5,
      );
      expect(statOwnedFile(first, "alpha", 5)).toEqual(alpha);
      expect(readOwnedUtf8(first, "alpha", 5)).toEqual({
        content: "alpha",
        evidence: alpha,
      });
      expect(readOwnedPrefix(first, "alpha", 5, 2)).toMatchObject({
        bytes: Buffer.from("al"),
        evidence: alpha,
      });
      expect(syncOwnedFile(first, "alpha", 5)).toEqual(alpha);
      syncOwnedDirectory(first);

      for (const name of [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "x\0y",
        "x".repeat(256),
      ])
        expect(() =>
          writeOwnedExclusive(first, name, Buffer.from("x"), 1),
        ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(() =>
        writeOwnedExclusive(first, "empty", Buffer.alloc(0), 1),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      const empty = writeOwnedExclusive(
        first,
        "empty",
        Buffer.alloc(0),
        0,
        true,
      );
      expect(empty.bytes).toBe(0);
      expect(() => readOwnedUtf8(first, "empty", 0)).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      expect(readOwnedUtf8(first, "empty", 0, false).content).toBe("");
      expect(() => statOwnedFile(first, "alpha", 4)).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      for (const maximumReadBytes of [0, 6, 1.5])
        expect(() =>
          readOwnedPrefix(first, "alpha", 5, maximumReadBytes),
        ).toThrow(LocalSqliteOwnedFilesystemError);

      expect(boundedOwnedNames(first, 2)).toEqual(["alpha", "empty"]);
      expect(() => boundedOwnedNames(first, 1)).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      mkdirSync(join(firstPath, "directory"), { mode: 0o700 });
      expect(() => removeOwnedFile(first, "directory")).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      rmSync(join(firstPath, "directory"), { recursive: true });
      expect(removeOwnedFile(first, "alpha", "dev:0:ino:0")).toBe("mismatch");

      const linked = linkOwnedFile(
        first,
        "alpha",
        "linked",
        alpha.physicalIdentity,
      );
      expect(linked.physicalIdentity).toBe(alpha.physicalIdentity);
      expect(() =>
        linkOwnedFile(first, "alpha", "bad-link", "dev:0:ino:0"),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(removeOwnedFile(first, "linked", linked.physicalIdentity)).toBe(
        "removed",
      );
      expect(removeOwnedFile(first, "linked")).toBe("absent");

      expect(() =>
        renameOwnedFile(first, "alpha", second, "renamed", "dev:0:ino:0"),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      const renamed = renameOwnedFile(
        first,
        "alpha",
        second,
        "renamed",
        alpha.physicalIdentity,
      );
      expect(readFileSync(join(secondPath, "renamed"), "utf8")).toBe("alpha");
      writeFileSync(join(firstPath, "occupied"), "occupied", { mode: 0o600 });
      expect(() =>
        renameOwnedFile(
          second,
          "renamed",
          first,
          "occupied",
          renamed.physicalIdentity,
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);

      const replacement = writeOwnedExclusive(
        first,
        "replacement",
        Buffer.from("replacement"),
        11,
      );
      const occupied = statOwnedFile(first, "occupied", 8);
      expect(() =>
        replaceOwnedFile(
          first,
          "replacement",
          "occupied",
          "dev:0:ino:0",
          occupied.physicalIdentity,
          guardedPathExchange(firstPath),
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      const replaced = replaceOwnedFile(
        first,
        "replacement",
        "occupied",
        replacement.physicalIdentity,
        occupied.physicalIdentity,
        guardedPathExchange(firstPath),
      );
      expect(replaced.physicalIdentity).toBe(replacement.physicalIdentity);
      expect(readFileSync(join(firstPath, "occupied"), "utf8")).toBe(
        "replacement",
      );

      const sameSource = writeOwnedExclusive(
        first,
        "same-source",
        Buffer.from("same"),
        4,
      );
      expect(
        renameOwnedFile(
          first,
          "same-source",
          first,
          "same-destination",
          sameSource.physicalIdentity,
        ).physicalIdentity,
      ).toBe(sameSource.physicalIdentity);

      const retainedPath = join(root, "first-retained");
      renameSync(firstPath, retainedPath);
      mkdirSync(firstPath, { mode: 0o700 });
      expect(() => {
        first.assertCurrent();
      }).toThrow(LocalSqliteOwnedFilesystemError);
    } finally {
      first.close();
      first.close();
      second.close();
      expect(() => {
        first.assertCurrent();
      }).toThrow(LocalSqliteOwnedFilesystemError);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps native I/O bound to the retained inode across a final-name swap", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-file-"));
    chmodSync(root, 0o700);
    writeFileSync(join(root, "active"), "alpha", { mode: 0o600 });
    const directory = openOwnedDirectory(root, true);
    const retained = openOwnedFile(directory, "active", 5, { writable: true });
    try {
      const readOnly = openOwnedFile(directory, "active", 5);
      expect(readOnly.assertCurrent()).toMatchObject({ bytes: 5 });
      readOnly.close();
      expect(retained.sync()).toMatchObject({ bytes: 5 });
      renameSync(join(root, "active"), join(root, "active-retained"));
      writeFileSync(join(root, "active"), "omega", { mode: 0o600 });
      writeSync(retained.descriptor, Buffer.from("Z"), 0, 1, 0);
      expect(readFileSync(join(root, "active"), "utf8")).toBe("omega");
      expect(readFileSync(join(root, "active-retained"), "utf8")).toBe("Zlpha");
      expect(() => retained.assertCurrent()).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
    } finally {
      retained.close();
      expect(() => retained.assertCurrent()).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      expect(() => retained.sync()).toThrow(LocalSqliteOwnedFilesystemError);
      retained.close();
      directory.close();
      rmSync(root, { recursive: true, force: true });
    }

    const candidateRoot = mkdtempSync(
      join(tmpdir(), "agentscope-owned-candidate-"),
    );
    chmodSync(candidateRoot, 0o700);
    const candidateDirectory = openOwnedDirectory(candidateRoot, true);
    writeFileSync(join(candidateRoot, "empty-open"), Buffer.alloc(0), {
      mode: 0o600,
    });
    expect(() =>
      openOwnedFile(candidateDirectory, "empty-open", 1, {
        requireNonempty: true,
      }),
    ).toThrow(LocalSqliteOwnedFilesystemError);
    expect(() =>
      createOwnedExclusiveFile(
        candidateDirectory,
        "too-large",
        1,
        Buffer.from("xx"),
      ),
    ).toThrow(LocalSqliteOwnedFilesystemError);
    const candidate = createOwnedExclusiveFile(
      candidateDirectory,
      "candidate",
      5,
      Buffer.from("seed"),
    );
    try {
      writeSync(candidate.descriptor, Buffer.from("owned"), 0, 5, 0);
      expect(candidate.sync()).toMatchObject({ bytes: 5 });
      expect(readFileSync(join(candidateRoot, "candidate"), "utf8")).toBe(
        "owned",
      );
      renameSync(
        join(candidateRoot, "candidate"),
        join(candidateRoot, "candidate-retained"),
      );
      writeFileSync(join(candidateRoot, "candidate"), "other", {
        mode: 0o600,
      });
      expect(() => candidate.assertCurrent()).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
    } finally {
      candidate.close();
      expect(() => candidate.assertCurrent()).toThrow(
        LocalSqliteOwnedFilesystemError,
      );
      expect(() => candidate.sync()).toThrow(LocalSqliteOwnedFilesystemError);
      candidate.close();
      candidateDirectory.close();
      rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  it("never deletes or publishes a public-name replacement after claiming authority", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-claims-"));
    chmodSync(root, 0o700);
    const directory = openOwnedDirectory(root, true);
    try {
      writeFileSync(join(root, "remove"), "owned", { mode: 0o600 });
      const removeIdentity = statOwnedFile(
        directory,
        "remove",
      ).physicalIdentity;
      expect(
        removeOwnedFile(directory, "remove", removeIdentity, () => {
          writeFileSync(join(root, "remove"), "replacement", { mode: 0o600 });
        }),
      ).toBe("mismatch");
      expect(readFileSync(join(root, "remove"), "utf8")).toBe("replacement");

      writeFileSync(join(root, "remove-claim"), "owned", { mode: 0o600 });
      const removeClaimIdentity = statOwnedFile(
        directory,
        "remove-claim",
      ).physicalIdentity;
      expect(
        removeOwnedFile(directory, "remove-claim", removeClaimIdentity, () => {
          const claim = readdirSync(root).find((name) =>
            name.startsWith(".agentscope-private-"),
          );
          if (claim === undefined) throw new Error("claim fixture missing");
          renameSync(join(root, claim), join(root, "remove-claim-retained"));
          writeFileSync(join(root, claim), "replacement", { mode: 0o600 });
        }),
      ).toBe("mismatch");
      expect(readFileSync(join(root, "remove-claim"), "utf8")).toBe(
        "replacement",
      );

      writeFileSync(join(root, "remove-symlink"), "owned", { mode: 0o600 });
      const removeSymlinkIdentity = statOwnedFile(
        directory,
        "remove-symlink",
      ).physicalIdentity;
      expect(() =>
        removeOwnedFile(
          directory,
          "remove-symlink",
          removeSymlinkIdentity,
          () => {
            symlinkSync(
              join(root, "remove-claim"),
              join(root, "remove-symlink"),
            );
          },
        ),
      ).toThrow();

      writeFileSync(join(root, "rename"), "owned", { mode: 0o600 });
      const renameIdentity = statOwnedFile(
        directory,
        "rename",
      ).physicalIdentity;
      expect(() =>
        renameOwnedFile(
          directory,
          "rename",
          directory,
          "renamed",
          renameIdentity,
          () => {
            writeFileSync(join(root, "rename"), "replacement", {
              mode: 0o600,
            });
          },
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(readFileSync(join(root, "rename"), "utf8")).toBe("replacement");
      expect(readFileSync(join(root, "renamed"), "utf8")).toBe("owned");

      writeFileSync(join(root, "rename-claim"), "owned", { mode: 0o600 });
      const renameClaimIdentity = statOwnedFile(
        directory,
        "rename-claim",
      ).physicalIdentity;
      expect(() =>
        renameOwnedFile(
          directory,
          "rename-claim",
          directory,
          "rename-claim-output",
          renameClaimIdentity,
          () => {
            const claim = readdirSync(root).find((name) =>
              name.startsWith(".agentscope-private-"),
            );
            if (claim === undefined) throw new Error("claim fixture missing");
            renameSync(join(root, claim), join(root, "rename-claim-retained"));
            writeFileSync(join(root, claim), "replacement", { mode: 0o600 });
          },
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(readFileSync(join(root, "rename-claim"), "utf8")).toBe(
        "replacement",
      );

      writeFileSync(join(root, "rename-conflict"), "owned", { mode: 0o600 });
      const renameConflictIdentity = statOwnedFile(
        directory,
        "rename-conflict",
      ).physicalIdentity;
      expect(() =>
        renameOwnedFile(
          directory,
          "rename-conflict",
          directory,
          "rename-conflict-output",
          renameConflictIdentity,
          () => {
            writeFileSync(join(root, "rename-conflict-output"), "occupied", {
              mode: 0o600,
            });
          },
        ),
      ).toThrow();
      expect(readFileSync(join(root, "rename-conflict"), "utf8")).toBe("owned");

      writeFileSync(join(root, "link"), "owned", { mode: 0o600 });
      const linkIdentity = statOwnedFile(directory, "link").physicalIdentity;
      expect(() =>
        linkOwnedFile(directory, "link", "linked", linkIdentity, () => {
          renameSync(join(root, "link"), join(root, "link-retained"));
          writeFileSync(join(root, "link"), "replacement", { mode: 0o600 });
        }),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(readFileSync(join(root, "link"), "utf8")).toBe("replacement");
      expect(readFileSync(join(root, "linked"), "utf8")).toBe("owned");

      writeFileSync(join(root, "candidate"), "candidate", { mode: 0o600 });
      writeFileSync(join(root, "active"), "active", { mode: 0o600 });
      const candidateIdentity = statOwnedFile(
        directory,
        "candidate",
      ).physicalIdentity;
      const activeIdentity = statOwnedFile(
        directory,
        "active",
      ).physicalIdentity;
      expect(() =>
        replaceOwnedFile(
          directory,
          "candidate",
          "active",
          candidateIdentity,
          activeIdentity,
          guardedPathExchange(root),
          () => {
            renameSync(
              join(root, "candidate"),
              join(root, "candidate-retained"),
            );
            writeFileSync(join(root, "candidate"), "replacement", {
              mode: 0o600,
            });
          },
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(readFileSync(join(root, "candidate"), "utf8")).toBe("replacement");
      expect(readFileSync(join(root, "active"), "utf8")).toBe("active");

      writeFileSync(join(root, "candidate-destination-race"), "candidate-2", {
        mode: 0o600,
      });
      writeFileSync(join(root, "active-destination-race"), "active-2", {
        mode: 0o600,
      });
      const candidateDestinationRaceIdentity = statOwnedFile(
        directory,
        "candidate-destination-race",
      ).physicalIdentity;
      const activeDestinationRaceIdentity = statOwnedFile(
        directory,
        "active-destination-race",
      ).physicalIdentity;
      expect(() =>
        replaceOwnedFile(
          directory,
          "candidate-destination-race",
          "active-destination-race",
          candidateDestinationRaceIdentity,
          activeDestinationRaceIdentity,
          guardedPathExchange(root),
          () => {
            renameSync(
              join(root, "active-destination-race"),
              join(root, "active-destination-race-retained"),
            );
            writeFileSync(
              join(root, "active-destination-race"),
              "replacement-2",
              { mode: 0o600 },
            );
          },
        ),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(
        readFileSync(join(root, "candidate-destination-race"), "utf8"),
      ).toBe("candidate-2");
      expect(readFileSync(join(root, "active-destination-race"), "utf8")).toBe(
        "replacement-2",
      );
      expect(
        readFileSync(join(root, "active-destination-race-retained"), "utf8"),
      ).toBe("active-2");
      expect(
        boundedOwnedNames(directory, 32).some((name) =>
          name.startsWith(".agentscope-private-"),
        ),
      ).toBe(false);
    } finally {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports non-private directory permissions without widening authority", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-fs-mode-"));
    chmodSync(root, 0o755);
    const directory = openOwnedDirectory(root, true);
    try {
      expect(directory.currentUserOnly).toBe(false);
    } finally {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans a partially created file when the retained directory is replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-owned-create-race-"));
    const active = join(root, "active");
    const retained = join(root, "retained");
    chmodSync(root, 0o700);
    mkdirSync(active, { mode: 0o700 });
    const directory = openOwnedDirectory(active, true);
    try {
      renameSync(active, retained);
      mkdirSync(active, { mode: 0o700 });
      expect(() =>
        createOwnedExclusiveFile(directory, "candidate", 8, Buffer.from("x")),
      ).toThrow(LocalSqliteOwnedFilesystemError);
      expect(existsSync(join(active, "candidate"))).toBe(false);
      expect(existsSync(join(retained, "candidate"))).toBe(false);
    } finally {
      directory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "linux")(
    "rejects pathname fallback unless a testing authority explicitly permits it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-owned-fs-fallback-"));
      try {
        expect(() => openOwnedDirectory(root)).toThrow(
          LocalSqliteOwnedFilesystemError,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "never redirects a write through a replaced parent namespace",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-owned-fs-"));
      const ownedPath = join(root, "owned");
      const retainedPath = join(root, "retained");
      const outsidePath = join(root, "outside");
      chmodSync(root, 0o700);
      mkdirSync(ownedPath, { mode: 0o700 });
      mkdirSync(outsidePath, { mode: 0o700 });
      const authority = openOwnedDirectory(ownedPath);
      try {
        renameSync(ownedPath, retainedPath);
        symlinkSync(outsidePath, ownedPath, "dir");
        expect(() =>
          writeOwnedExclusive(
            authority,
            "intent-v1.json",
            Buffer.from("owned", "utf8"),
            64,
          ),
        ).toThrow(LocalSqliteOwnedFilesystemError);
        expect(existsSync(join(outsidePath, "intent-v1.json"))).toBe(false);
        expect(existsSync(join(retainedPath, "intent-v1.json"))).toBe(true);
      } finally {
        authority.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
/* eslint-enable max-lines-per-function */
