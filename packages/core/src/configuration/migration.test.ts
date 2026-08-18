import { compileDestinationRegistry } from "@agentscope/destinations-core";
import { describe, expect, it } from "vitest";

import {
  CONFIGURATION_V1_TO_V2_MIGRATION,
  DEFAULT_CONFIGURATION_MIGRATION_REGISTRY,
  compileConfigurationMigrationRegistry,
  ConfigurationMigrationError,
  migrateConfigurationDocument,
  type ConfigurationMigration,
} from "./migration.js";

const destinations = compileDestinationRegistry([]);
const currentDocument = () => ({
  configurationVersion: 2,
  generation: 3,
  destinations: {},
  routing: {
    version: 1,
    selectedConnectionIds: [],
    hookDeadlineMilliseconds: 2_000,
  },
  policy: { version: 1, reference: "policy-v1" },
});
const versionOneDocument = () => ({
  configurationVersion: 1,
  generation: 3,
  destinations: {},
  routing: { version: 1, selectedConnectionIds: [] },
  policy: { version: 1, reference: "policy-v1" },
});
const legacyDocument = () => ({
  configurationVersion: 0,
  generation: 3,
  destinationBlocks: {},
  selectedConnectionIds: [],
  policyReference: "policy-v1",
});
const edgeZero: ConfigurationMigration = {
  fromVersion: 0,
  toVersion: 1,
  migrate: (input) => ({
    configurationVersion: 1,
    generation: input.generation,
    destinations: input.destinationBlocks,
    routing: {
      version: 1,
      selectedConnectionIds: input.selectedConnectionIds,
    },
    policy: { version: 1, reference: input.policyReference },
  }),
};
const edgeOne = CONFIGURATION_V1_TO_V2_MIGRATION;

describe("configuration migration registry", () => {
  it("migrates a bounded fresh document through an exact adjacent edge", () => {
    const input = legacyDocument();
    const registry = compileConfigurationMigrationRegistry([edgeZero, edgeOne]);
    const migrated = migrateConfigurationDocument(
      input,
      registry,
      destinations,
    );
    expect(migrated).toMatchObject({
      configurationVersion: 2,
      generation: 3,
      mutationSafe: true,
      policyReference: "policy-v1",
    });
    expect(migrated.document).toEqual(currentDocument());
    expect(input).toEqual(legacyDocument());
    expect(migrated.document).not.toBe(input);
    expect(Object.isFrozen(migrated.document)).toBe(true);
  });

  it("accepts the current generation without invoking a migration", () => {
    let calls = 0;
    const registry = compileConfigurationMigrationRegistry([
      { ...edgeZero, migrate: () => (calls += 1) },
      edgeOne,
    ]);
    expect(
      migrateConfigurationDocument(currentDocument(), registry, destinations)
        .generation,
    ).toBe(3);
    expect(calls).toBe(0);
    expect(
      migrateConfigurationDocument(
        versionOneDocument(),
        DEFAULT_CONFIGURATION_MIGRATION_REGISTRY,
        destinations,
      ).document,
    ).toEqual(currentDocument());
  });

  it("rejects sparse, duplicate, nonadjacent, future, and forged registries", () => {
    const sparse = new Array<ConfigurationMigration>(1);
    const accessor = [edgeZero];
    Object.defineProperty(accessor, "0", { get: () => edgeZero });
    const customIterator: ConfigurationMigration[] = [];
    Object.defineProperty(customIterator, Symbol.iterator, {
      value: function* () {
        yield edgeZero;
      },
    });
    for (const migrations of [
      null,
      new Array<ConfigurationMigration>(33).fill(edgeZero),
      sparse,
      accessor,
      customIterator,
      [null],
      [edgeZero, edgeZero],
      [{ ...edgeZero, toVersion: 2 }],
      [{ ...edgeZero, fromVersion: -1, toVersion: 0 }],
      [{ ...edgeOne, fromVersion: 2, toVersion: 3 }],
      [{ ...edgeZero, migrate: null }],
      [
        {
          fromVersion: 0,
          toVersion: 1,
          migrate: edgeZero.migrate,
          extra: true,
        },
      ],
    ])
      expect(() =>
        compileConfigurationMigrationRegistry(migrations as never),
      ).toThrowError(ConfigurationMigrationError);
    expect(() =>
      migrateConfigurationDocument(
        currentDocument(),
        { configurationMigrations: "agentscope-core" },
        destinations,
      ),
    ).toThrowError(ConfigurationMigrationError);
  });
});

describe("configuration migration failure boundaries", () => {
  it("refuses future input and missing or malformed edges", () => {
    const empty = compileConfigurationMigrationRegistry([]);
    const wrongVersion = compileConfigurationMigrationRegistry([
      {
        ...edgeZero,
        migrate: () => ({ ...currentDocument(), configurationVersion: 0 }),
      },
    ]);
    const malformed = compileConfigurationMigrationRegistry([
      { ...edgeZero, migrate: () => ({ configurationVersion: 1 }) },
      edgeOne,
    ]);
    for (const [input, registry, code] of [
      [{ ...currentDocument(), configurationVersion: 3 }, empty, "downgrade"],
      [legacyDocument(), empty, "migration-failed"],
      [legacyDocument(), wrongVersion, "migration-failed"],
      [legacyDocument(), malformed, "migration-failed"],
      [
        { ...currentDocument(), policy: { version: 1, reference: "INVALID" } },
        empty,
        "migration-failed",
      ],
      [{ generation: 0 }, empty, "migration-invalid"],
      [null, empty, "migration-invalid"],
    ] as const)
      expect(() =>
        migrateConfigurationDocument(input, registry, destinations),
      ).toThrowError(
        expect.objectContaining({ code: `core.configuration.${code}` }),
      );
  });

  it("contains thrown and accidental asynchronous migration failures", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      for (const migrate of [
        () => {
          throw new Error("CANARY_SECRET");
        },
        () => Promise.reject(new Error("CANARY_SECRET")),
        () => Promise.resolve(currentDocument()),
        () => ({ ...currentDocument(), value: Symbol("not-json") }),
      ]) {
        const registry = compileConfigurationMigrationRegistry([
          { ...edgeZero, migrate },
        ]);
        expect(() =>
          migrateConfigurationDocument(
            legacyDocument(),
            registry,
            destinations,
          ),
        ).toThrowError(
          expect.objectContaining({
            code: "core.configuration.migration-failed",
          }),
        );
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
