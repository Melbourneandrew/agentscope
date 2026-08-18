import type {
  DestinationRegistry,
  JsonObject,
} from "@agentscope/destinations-core";

import { cloneConfigurationDocument } from "./plain-data.js";
import {
  AGENTSCOPE_CONFIGURATION_VERSION,
  DEFAULT_HOOK_DEADLINE_MILLISECONDS,
  parseAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
} from "./schema.js";

export type ConfigurationMigration = Readonly<{
  fromVersion: number;
  toVersion: number;
  migrate: (document: JsonObject) => unknown;
}>;

export type ConfigurationMigrationRegistry = Readonly<{
  readonly configurationMigrations: "agentscope-core";
}>;

export type ConfigurationMigrationErrorCode =
  | "core.configuration.downgrade"
  | "core.configuration.migration-failed"
  | "core.configuration.migration-invalid";

export class ConfigurationMigrationError extends Error {
  public constructor(public readonly code: ConfigurationMigrationErrorCode) {
    super(code);
    this.name = "ConfigurationMigrationError";
  }
}

const migrationRegistries = new WeakMap<
  object,
  ReadonlyMap<number, ConfigurationMigration>
>();

const invalid = (code: ConfigurationMigrationErrorCode): never => {
  throw new ConfigurationMigrationError(code);
};

const denseMigrations = (input: unknown): readonly ConfigurationMigration[] => {
  if (!Array.isArray(input) || input.length > 32)
    return invalid("core.configuration.migration-invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== input.length + 1 ||
    keys.some((key) => typeof key !== "string")
  )
    return invalid("core.configuration.migration-invalid");
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor))
      return invalid("core.configuration.migration-invalid");
    const value: unknown = descriptor.value;
    if (typeof value !== "object" || value === null)
      return invalid("core.configuration.migration-invalid");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(fields).sort().join(",") !== "fromVersion,migrate,toVersion"
    )
      return invalid("core.configuration.migration-invalid");
    const fromVersion = fields.fromVersion?.value as unknown;
    const toVersion = fields.toVersion?.value as unknown;
    const migrate = fields.migrate?.value as unknown;
    if (
      !Number.isSafeInteger(fromVersion) ||
      typeof fromVersion !== "number" ||
      fromVersion < 0 ||
      toVersion !== fromVersion + 1 ||
      toVersion > AGENTSCOPE_CONFIGURATION_VERSION ||
      typeof migrate !== "function"
    )
      return invalid("core.configuration.migration-invalid");
    return Object.freeze({
      fromVersion,
      toVersion,
      migrate: migrate as ConfigurationMigration["migrate"],
    });
  });
};

export const compileConfigurationMigrationRegistry = (
  migrations: readonly ConfigurationMigration[],
): ConfigurationMigrationRegistry => {
  const bySource = new Map<number, ConfigurationMigration>();
  for (const migration of denseMigrations(migrations)) {
    if (bySource.has(migration.fromVersion))
      return invalid("core.configuration.migration-invalid");
    bySource.set(migration.fromVersion, migration);
  }
  const registry = Object.freeze({
    configurationMigrations: "agentscope-core" as const,
  });
  migrationRegistries.set(registry, bySource);
  return registry;
};

export const CONFIGURATION_V1_TO_V2_MIGRATION: ConfigurationMigration =
  Object.freeze({
    fromVersion: 1,
    toVersion: 2,
    migrate: (input: JsonObject): unknown => {
      const routing = input.routing;
      if (typeof routing !== "object" || routing === null) return input;
      return {
        ...input,
        configurationVersion: 2,
        routing: {
          ...routing,
          hookDeadlineMilliseconds: DEFAULT_HOOK_DEADLINE_MILLISECONDS,
        },
      };
    },
  });

export const DEFAULT_CONFIGURATION_MIGRATION_REGISTRY =
  compileConfigurationMigrationRegistry([CONFIGURATION_V1_TO_V2_MIGRATION]);

const configurationVersion = (document: JsonObject): number => {
  const descriptor = Object.getOwnPropertyDescriptor(
    document,
    "configurationVersion",
  );
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    typeof descriptor.value !== "number" ||
    descriptor.value < 0
  )
    return invalid("core.configuration.migration-invalid");
  return descriptor.value;
};

const observeUnexpectedPromise = (value: unknown): void => {
  if (!(value instanceof Promise)) return;
  void value.then(
    () => undefined,
    () => undefined,
  );
};

export const migrateConfigurationDocument = (
  input: unknown,
  migrations: ConfigurationMigrationRegistry,
  destinations: DestinationRegistry,
): AgentscopeConfigurationSnapshot => {
  const registry = migrationRegistries.get(migrations);
  if (!registry) return invalid("core.configuration.migration-invalid");
  let document: JsonObject;
  try {
    document = cloneConfigurationDocument(input);
  } catch {
    return invalid("core.configuration.migration-invalid");
  }
  let version = configurationVersion(document);
  if (version > AGENTSCOPE_CONFIGURATION_VERSION)
    return invalid("core.configuration.downgrade");
  while (version < AGENTSCOPE_CONFIGURATION_VERSION) {
    const migration = registry.get(version);
    if (!migration) return invalid("core.configuration.migration-failed");
    let candidate: unknown;
    try {
      candidate = migration.migrate(document);
      observeUnexpectedPromise(candidate);
      document = cloneConfigurationDocument(candidate);
    } catch {
      return invalid("core.configuration.migration-failed");
    }
    const nextVersion = configurationVersion(document);
    if (nextVersion !== migration.toVersion)
      return invalid("core.configuration.migration-failed");
    version = nextVersion;
  }
  try {
    return parseAgentscopeConfiguration(document, destinations);
  } catch {
    return invalid("core.configuration.migration-failed");
  }
};
