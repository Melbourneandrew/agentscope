import { compileDestinationRegistry } from "@agentscope/destinations-core";
import { describe, expect, it } from "vitest";

import {
  compileConfigurationMigrationRegistry,
  ConfigurationMigrationError,
  migrateConfigurationDocument,
  type ConfigurationMigration,
} from "./migration.js";

const destinations = compileDestinationRegistry([]);
const currentDocument = () => ({
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
const edge: ConfigurationMigration = {
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

describe("configuration migration registry", () => {
  it("migrates a bounded fresh document through an exact adjacent edge", () => {
    const input = legacyDocument();
    const registry = compileConfigurationMigrationRegistry([edge]);
    const migrated = migrateConfigurationDocument(
      input,
      registry,
      destinations,
    );
    expect(migrated).toMatchObject({
      configurationVersion: 1,
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
      { ...edge, migrate: () => (calls += 1) },
    ]);
    expect(
      migrateConfigurationDocument(currentDocument(), registry, destinations)
        .generation,
    ).toBe(3);
    expect(calls).toBe(0);
  });

  it("rejects sparse, duplicate, nonadjacent, future, and forged registries", () => {
    const sparse = new Array<ConfigurationMigration>(1);
    const accessor = [edge];
    Object.defineProperty(accessor, "0", { get: () => edge });
    const customIterator: ConfigurationMigration[] = [];
    Object.defineProperty(customIterator, Symbol.iterator, {
      value: function* () {
        yield edge;
      },
    });
    for (const migrations of [
      null,
      new Array<ConfigurationMigration>(33).fill(edge),
      sparse,
      accessor,
      customIterator,
      [null],
      [edge, edge],
      [{ ...edge, toVersion: 2 }],
      [{ ...edge, fromVersion: -1, toVersion: 0 }],
      [{ ...edge, fromVersion: 1, toVersion: 2 }],
      [{ ...edge, migrate: null }],
      [{ fromVersion: 0, toVersion: 1, migrate: edge.migrate, extra: true }],
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
        ...edge,
        migrate: () => ({ ...currentDocument(), configurationVersion: 0 }),
      },
    ]);
    const malformed = compileConfigurationMigrationRegistry([
      { ...edge, migrate: () => ({ configurationVersion: 1 }) },
    ]);
    for (const [input, registry, code] of [
      [{ ...currentDocument(), configurationVersion: 2 }, empty, "downgrade"],
      [legacyDocument(), empty, "migration-failed"],
      [legacyDocument(), wrongVersion, "migration-failed"],
      [legacyDocument(), malformed, "migration-failed"],
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
          { ...edge, migrate },
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
