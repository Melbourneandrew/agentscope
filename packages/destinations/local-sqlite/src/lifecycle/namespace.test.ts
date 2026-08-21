import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  compileLocalSqlitePhysicalNamespaceEvidence,
  LocalSqliteNamespaceError,
  planLocalSqliteNamespace,
  type LocalSqliteNamespacePlan,
  type LocalSqlitePhysicalNamespaceEvidenceInput,
} from "./namespace.js";

const connectionId = `destination-connection-v1-${"1".repeat(64)}`;

const evidence = (
  plan: LocalSqliteNamespacePlan,
): LocalSqlitePhysicalNamespaceEvidenceInput => ({
  absenceBoundary: null,
  existingAncestors: [
    {
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path: plan.agentscopeHome,
      physicalIdentity: "dev1:ino1",
      role: "agentscope-home",
      state: "existing",
    },
    {
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path: plan.destinationsDirectory,
      physicalIdentity: "dev1:ino2",
      role: "destinations",
      state: "existing",
    },
    {
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path: plan.destinationTypeDirectory,
      physicalIdentity: "dev1:ino3",
      role: "destination-type",
      state: "existing",
    },
    {
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path: plan.connectionNamespace,
      physicalIdentity: "dev1:ino4",
      role: "connection-namespace",
      state: "existing",
    },
  ],
  filesystemProfile: "local-apfs",
  plannedAbsentAncestors: [],
  schemaVersion: 1,
});

describe("Local SQLite owned namespace authority", () => {
  it("exposes one fixed namespace error code", () => {
    expect(new LocalSqliteNamespaceError().code).toBe(
      "destination.local-sqlite.namespace-invalid",
    );
  });

  it("derives the exact POSIX namespace from the connection identity", () => {
    const plan = planLocalSqliteNamespace({
      agentscopeHome: "/Users/example/.agentscope",
      connectionId,
      platform: "posix",
    });
    expect(plan.connectionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.connectionDigest).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            connectionId,
            destinationType: "@agentscope/destination-local-sqlite",
          }),
        )
        .digest("hex"),
    );
    expect(plan.connectionNamespace).toBe(
      `/Users/example/.agentscope/destinations/local-sqlite/${plan.connectionDigest}`,
    );
    expect(plan.databasePath).toBe(`${plan.connectionNamespace}/traces.sqlite`);
    expect(plan.lifecycleDirectory).toBe(
      `${plan.connectionNamespace}/lifecycle`,
    );
    expect(plan.backupsDirectory).toBe(`${plan.connectionNamespace}/backups`);
    expect(plan.fingerprint).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("derives a canonical Windows namespace without accepting UNC or roots", () => {
    const plan = planLocalSqliteNamespace({
      agentscopeHome: "C:\\Users\\example\\.agentscope",
      connectionId,
      platform: "win32",
    });
    expect(plan.databasePath).toBe(
      `C:\\Users\\example\\.agentscope\\destinations\\local-sqlite\\${plan.connectionDigest}\\traces.sqlite`,
    );
    for (const agentscopeHome of [
      "C:\\",
      "c:\\Users\\example",
      "\\\\server\\share",
      "C:\\Users\\example\\..\\other",
      "C:\\Users\\example\\CON",
      "C:\\Users\\example\\com1.txt",
      "C:\\Users\\example\\LPT¹.log",
      "C:\\Users\\example\\CONOUT$",
      "C:\\Users\\example\\name.",
      "C:\\Users\\example\\name ",
      "C:\\Users\\example\\name:stream",
      "C:\\Users\\example\\\ud800",
      `C:\\Users\\example\\${"a".repeat(256)}`,
    ]) {
      expect(() =>
        planLocalSqliteNamespace({
          agentscopeHome,
          connectionId,
          platform: "win32",
        }),
      ).toThrowError(LocalSqliteNamespaceError);
    }
  });

  it("binds exact no-follow physical evidence to the namespace plan", () => {
    const plan = planLocalSqliteNamespace({
      agentscopeHome: "/Users/example/.agentscope",
      connectionId,
      platform: "posix",
    });
    const compiled = compileLocalSqlitePhysicalNamespaceEvidence(
      plan,
      evidence(plan),
    );
    expect(compiled.namespaceFingerprint).toBe(plan.fingerprint);
    expect(compiled.existingAncestors).toHaveLength(4);
    expect(compiled.plannedAbsentAncestors).toHaveLength(0);
    expect(compiled.fingerprint).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(Object.isFrozen(compiled.existingAncestors)).toBe(true);
    const forged = { ...plan };
    expect(() =>
      compileLocalSqlitePhysicalNamespaceEvidence(
        forged as LocalSqliteNamespacePlan,
        evidence(plan),
      ),
    ).toThrowError(LocalSqliteNamespaceError);
  });
});

describe("Local SQLite first-configure namespace authority", () => {
  it("binds a deepest existing prefix and mutation-free planned suffix", () => {
    const plan = planLocalSqliteNamespace({
      agentscopeHome: "/Users/example/.agentscope",
      connectionId,
      platform: "posix",
    });
    const firstConfigure = {
      absenceBoundary: {
        firstAbsentPath: plan.destinationsDirectory,
        firstAbsentRole: "destinations",
        nameCollisionFree: true,
        noFollow: true,
        parentPath: plan.agentscopeHome,
        parentPhysicalIdentity: "dev1:ino1",
        parentRole: "agentscope-home",
      },
      existingAncestors: [
        {
          currentUserOnly: true,
          kind: "directory",
          noFollow: true,
          path: plan.agentscopeHome,
          physicalIdentity: "dev1:ino1",
          role: "agentscope-home",
          state: "existing",
        },
      ],
      filesystemProfile: "local-apfs",
      plannedAbsentAncestors: [
        {
          createMode: "current-user-only",
          noFollow: true,
          path: plan.destinationsDirectory,
          role: "destinations",
          state: "planned-absent",
        },
        {
          createMode: "current-user-only",
          noFollow: true,
          path: plan.destinationTypeDirectory,
          role: "destination-type",
          state: "planned-absent",
        },
        {
          createMode: "current-user-only",
          noFollow: true,
          path: plan.connectionNamespace,
          role: "connection-namespace",
          state: "planned-absent",
        },
      ],
      schemaVersion: 1,
    } as const;
    const before = structuredClone(firstConfigure);
    const compiled = compileLocalSqlitePhysicalNamespaceEvidence(
      plan,
      firstConfigure,
    );
    expect(firstConfigure).toEqual(before);
    expect(compiled.existingAncestors).toHaveLength(1);
    expect(compiled.plannedAbsentAncestors).toHaveLength(3);
    expect(compiled.absenceBoundary).toMatchObject({
      firstAbsentRole: "destinations",
      parentRole: "agentscope-home",
    });
    for (const candidate of [
      {
        ...firstConfigure,
        plannedAbsentAncestors: firstConfigure.plannedAbsentAncestors.map(
          (ancestor, index) =>
            index === 0 ? { ...ancestor, createMode: "future" } : ancestor,
        ),
      },
      {
        ...firstConfigure,
        absenceBoundary: {
          ...firstConfigure.absenceBoundary,
          parentPath: "/substituted",
        },
      },
    ]) {
      expect(() =>
        compileLocalSqlitePhysicalNamespaceEvidence(plan, candidate as never),
      ).toThrowError(LocalSqliteNamespaceError);
    }
  });
});

describe("Local SQLite namespace hostile evidence", () => {
  it("rejects aliases, reordered paths, extras, sparse arrays, and accessors", () => {
    const plan = planLocalSqliteNamespace({
      agentscopeHome: "/Users/example/.agentscope",
      connectionId,
      platform: "posix",
    });
    const base = evidence(plan);
    const aliased = {
      ...base,
      existingAncestors: base.existingAncestors.map((ancestor, index) => ({
        ...ancestor,
        physicalIdentity:
          index === 3
            ? base.existingAncestors[2]!.physicalIdentity
            : ancestor.physicalIdentity,
      })),
    };
    const reordered = {
      ...base,
      existingAncestors: [...base.existingAncestors].reverse(),
    };
    const extra = Object.assign(structuredClone(base).existingAncestors, {
      hidden: true,
    });
    const sparse = new Array(4);
    let calls = 0;
    const indexedAccessor = [...base.existingAncestors];
    Object.defineProperty(indexedAccessor, "0", {
      get() {
        calls += 1;
        return base.existingAncestors[0];
      },
    });
    const accessor = Object.defineProperty(
      structuredClone(base),
      "existingAncestors",
      {
        get() {
          calls += 1;
          return base.existingAncestors;
        },
      },
    );
    for (const candidate of [
      null,
      [],
      Object.create(null),
      aliased,
      reordered,
      { ...base, existingAncestors: extra },
      { ...base, existingAncestors: [] },
      {
        ...base,
        existingAncestors: [
          ...base.existingAncestors,
          base.existingAncestors[3],
        ],
      },
      { ...base, existingAncestors: sparse },
      { ...base, existingAncestors: null },
      { ...base, existingAncestors: indexedAccessor },
      { ...base, plannedAbsentAncestors: [null] },
      { ...base, absenceBoundary: {} },
      { ...base, extra: true },
      { ...base, schemaVersion: 2 },
      { ...base, filesystemProfile: "A" },
      { ...base, filesystemProfile: "a".repeat(97) },
      accessor,
    ]) {
      expect(() =>
        compileLocalSqlitePhysicalNamespaceEvidence(plan, candidate as never),
      ).toThrowError(LocalSqliteNamespaceError);
    }
    expect(calls).toBe(0);
  });
});

describe("Local SQLite namespace hostile plan inputs", () => {
  it("rejects noncanonical and executable values without coercion", () => {
    let calls = 0;
    const hostile = Object.freeze({
      toString() {
        calls += 1;
        return "/Users/example/.agentscope";
      },
      [Symbol.toPrimitive]() {
        calls += 1;
        return "/Users/example/.agentscope";
      },
    });
    const invalid = [
      null,
      [],
      Object.create(null),
      { agentscopeHome: "/", connectionId, platform: "posix" },
      {
        agentscopeHome: "/Users/example/../other",
        connectionId,
        platform: "posix",
      },
      {
        agentscopeHome: "/Users/example/\ud800",
        connectionId,
        platform: "posix",
      },
      {
        agentscopeHome: `/Users/example/${"a".repeat(256)}`,
        connectionId,
        platform: "posix",
      },
      {
        agentscopeHome: hostile,
        connectionId,
        platform: "posix",
      },
      {
        agentscopeHome: "/Users/example/.agentscope",
        connectionId: "invalid",
        platform: "posix",
      },
      {
        agentscopeHome: "/Users/example/.agentscope",
        connectionId,
        platform: "future",
      },
      {
        agentscopeHome: "/Users/example/.agentscope",
        connectionId,
        extra: true,
        platform: "posix",
      },
    ];
    for (const candidate of invalid) {
      expect(() => planLocalSqliteNamespace(candidate as never)).toThrowError(
        LocalSqliteNamespaceError,
      );
    }
    expect(calls).toBe(0);
  });
});
