import {
  applyHarnessInstallation,
  discoverHarness,
  getHarnessDescriptor,
  inspectHarnessInstallation,
  isHarnessRegistry,
  type HarnessDiscoveryProbe,
  type HarnessDiscoveryResult,
  type HarnessInstallationPlanInput,
  type HarnessInstallationResult,
  type HarnessRegistry,
} from "@agentscope/harnesses-core/cli-management";

import type { CliDiagnostic, CliOperationResult } from "./cli-contract.js";
import type {
  CliHarnessDiscovery,
  CliHarnessListValue,
  CliHarnessMutationValue,
  CliHarnessServices,
  CliHarnessStatusValue,
} from "./harness-commands.js";

const harnessNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maximumAdapters = 32;

export type CliHarnessAdapter = Readonly<{
  commandName: string;
  createInstallationInput: (
    operation: "install" | "migrate" | "uninstall",
  ) => HarnessInstallationPlanInput;
  harnessType: string;
  probe: HarnessDiscoveryProbe;
}>;

export type CreateHarnessCliServicesInput = Readonly<{
  adapters?: readonly CliHarnessAdapter[];
  registry?: HarnessRegistry;
}>;

type RegisteredAdapter = Readonly<{
  commandName: string;
  createInstallationInput: CliHarnessAdapter["createInstallationInput"];
  harnessType: string;
  probe: HarnessDiscoveryProbe;
}>;

const diagnostic = (
  category: CliDiagnostic["category"],
  code: string,
): CliDiagnostic => Object.freeze({ category, code });

const failure = <Value>(value: CliDiagnostic): CliOperationResult<Value> =>
  Object.freeze({ diagnostic: value, status: "failure" as const });

const success = <Value>(value: Value): CliOperationResult<Value> =>
  Object.freeze({ status: "success" as const, value });

const partial = <Value>(
  value: Value,
  valueDiagnostic: CliDiagnostic,
): CliOperationResult<Value> =>
  Object.freeze({
    diagnostic: valueDiagnostic,
    status: "partial" as const,
    value,
  });

const dataRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      )
    )
      return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value as unknown;
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
};

const functionRecord = (
  value: unknown,
  keys: readonly string[],
):
  Readonly<Record<string, (...arguments_: never[]) => unknown>> | undefined => {
  const record = dataRecord(value, keys);
  if (!record) return undefined;
  const output: Record<string, (...arguments_: never[]) => unknown> = {};
  for (const key of keys) {
    if (typeof record[key] !== "function") return undefined;
    output[key] = record[key] as (...arguments_: never[]) => unknown;
  }
  return Object.freeze(output);
};

const snapshotTargetPaths = (value: unknown): readonly string[] | undefined => {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 ||
      value.length > 16 ||
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !==
        value.length + 1
    )
      return undefined;
    const output: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        return undefined;
      output.push(descriptor.value);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
};

const createPlanInput = (
  adapter: RegisteredAdapter,
  operation: "install" | "migrate" | "uninstall",
): HarnessInstallationPlanInput | undefined => {
  try {
    const record = dataRecord(adapter.createInstallationInput(operation), [
      "manifestPath",
      "operation",
      "planner",
      "targetPaths",
    ]);
    const targetPaths = record
      ? snapshotTargetPaths(record.targetPaths)
      : undefined;
    if (
      !record ||
      record.operation !== operation ||
      typeof record.manifestPath !== "string" ||
      typeof record.planner !== "function" ||
      !targetPaths
    )
      return undefined;
    return Object.freeze({
      manifestPath: record.manifestPath,
      operation,
      planner: record.planner as HarnessInstallationPlanInput["planner"],
      targetPaths,
    });
  } catch {
    return undefined;
  }
};

const snapshotAdapters = (
  input: CreateHarnessCliServicesInput,
): ReadonlyMap<string, RegisteredAdapter> => {
  const adapters = input.adapters ?? [];
  if (
    !Array.isArray(adapters) ||
    Object.getPrototypeOf(adapters) !== Array.prototype ||
    adapters.length > maximumAdapters ||
    (adapters.length > 0 && !isHarnessRegistry(input.registry))
  )
    throw new Error("cli.harness.invalid");
  const output = new Map<string, RegisteredAdapter>();
  for (let index = 0; index < adapters.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(adapters, String(index));
    if (!descriptor || !("value" in descriptor))
      throw new Error("cli.harness.invalid");
    const record = dataRecord(descriptor.value, [
      "commandName",
      "createInstallationInput",
      "harnessType",
      "probe",
    ]);
    const probe = record
      ? functionRecord(record.probe, [
          "inspectConfiguration",
          "locateExecutable",
          "readVersion",
        ])
      : undefined;
    if (
      !record ||
      typeof record.commandName !== "string" ||
      !harnessNamePattern.test(record.commandName) ||
      typeof record.harnessType !== "string" ||
      record.harnessType !== `@agentscope/harness-${record.commandName}` ||
      typeof record.createInstallationInput !== "function" ||
      !probe ||
      output.has(record.commandName) ||
      !getHarnessDescriptor(input.registry!, record.harnessType)
    )
      throw new Error("cli.harness.invalid");
    output.set(
      record.commandName,
      Object.freeze({
        commandName: record.commandName,
        createInstallationInput:
          record.createInstallationInput as CliHarnessAdapter["createInstallationInput"],
        harnessType: record.harnessType,
        probe: Object.freeze({
          inspectConfiguration:
            probe.inspectConfiguration as HarnessDiscoveryProbe["inspectConfiguration"],
          locateExecutable:
            probe.locateExecutable as HarnessDiscoveryProbe["locateExecutable"],
          readVersion:
            probe.readVersion as HarnessDiscoveryProbe["readVersion"],
        }),
      }),
    );
  }
  return output;
};

const publicDiscovery = (
  adapter: RegisteredAdapter,
  value: HarnessDiscoveryResult,
): CliHarnessDiscovery =>
  Object.freeze({
    configurationLocationCount: value.configurationLocations.length,
    configurationPresentCount: value.configurationLocations.filter(
      (location) => location.present,
    ).length,
    harness: adapter.commandName,
    harnessType: value.harnessType,
    reason: value.reason,
    state: value.state,
    version: value.version,
  });

const planDiagnostic = (disposition: string): CliDiagnostic => {
  switch (disposition) {
    case "conflict":
      return diagnostic("conflict", "harness.overlap-conflict");
    case "unsupported":
      return diagnostic("unavailable", "harness.installation-unsupported");
    case "recovery-required":
      return diagnostic("conflict", "harness.recovery-required");
    case "invalid":
      return diagnostic("unavailable", "harness.plan-invalid");
    default:
      return diagnostic("unavailable", "harness.unavailable");
  }
};

const resultDiagnostic = (value: HarnessInstallationResult): CliDiagnostic =>
  planDiagnostic(value.state);

export const createHarnessCliServices = (
  input: CreateHarnessCliServicesInput = {},
): CliHarnessServices => {
  const adapters = snapshotAdapters(input);
  const registry = input.registry;

  const find = (name: string): RegisteredAdapter | undefined =>
    adapters.get(name);

  const discover = async (
    adapter: RegisteredAdapter,
  ): Promise<CliHarnessDiscovery> => {
    if (!registry) throw new Error("cli.harness.invalid");
    return publicDiscovery(
      adapter,
      await discoverHarness(registry, adapter.harnessType, adapter.probe),
    );
  };

  const manage = async (
    operation: "install" | "migrate" | "uninstall",
    harness: string,
    apply: boolean,
  ): Promise<CliOperationResult<CliHarnessMutationValue>> => {
    const adapter = find(harness);
    if (!adapter)
      return failure(diagnostic("not-found", "harness.adapter-missing"));
    if (operation !== "uninstall") {
      let discovered: CliHarnessDiscovery;
      try {
        discovered = await discover(adapter);
      } catch {
        return failure(diagnostic("unavailable", "harness.unavailable"));
      }
      if (discovered.state === "absent")
        return failure(diagnostic("not-found", "harness.absent"));
      if (discovered.state === "unsupported")
        return failure(
          diagnostic("unavailable", "harness.version-unsupported"),
        );
      if (discovered.state === "indeterminate")
        return failure(
          diagnostic("unavailable", "harness.discovery-indeterminate"),
        );
    }
    try {
      const input = createPlanInput(adapter, operation);
      if (!input)
        return failure(diagnostic("unavailable", "harness.plan-invalid"));
      const plan = await inspectHarnessInstallation(input);
      const value: CliHarnessMutationValue = {
        applied: false,
        changedTargetCount: plan.changedTargetCount,
        disposition: plan.disposition,
        harness,
        operation,
        targetCount: plan.targetCount,
      };
      if (plan.disposition !== "ready" && plan.disposition !== "unchanged")
        return partial(value, planDiagnostic(plan.disposition));
      if (!apply || plan.disposition === "unchanged") return success(value);
      const applied = await applyHarnessInstallation(plan);
      const appliedValue: CliHarnessMutationValue = {
        applied: applied.ok,
        changedTargetCount: applied.changedTargetCount,
        disposition: applied.state,
        harness,
        operation,
        targetCount: plan.targetCount,
      };
      return applied.ok
        ? success(appliedValue)
        : partial(appliedValue, resultDiagnostic(applied));
    } catch {
      return failure(diagnostic("unavailable", "harness.unavailable"));
    }
  };

  const services: CliHarnessServices = {
    installHarness: ({ apply, harness }) => manage("install", harness, apply),
    listHarnesses: async (): Promise<
      CliOperationResult<CliHarnessListValue>
    > => {
      const values: CliHarnessDiscovery[] = [];
      try {
        for (const adapter of adapters.values())
          values.push(await discover(adapter));
        return success({ harnesses: values });
      } catch {
        return failure(diagnostic("unavailable", "harness.unavailable"));
      }
    },
    migrateHarness: ({ apply, harness }) => manage("migrate", harness, apply),
    statusHarness: async ({
      harness,
    }): Promise<CliOperationResult<CliHarnessStatusValue>> => {
      const adapter = find(harness);
      if (!adapter)
        return failure(diagnostic("not-found", "harness.adapter-missing"));
      try {
        const input = createPlanInput(adapter, "install");
        if (!input)
          return failure(diagnostic("unavailable", "harness.unavailable"));
        const [discovery, installation] = await Promise.all([
          discover(adapter),
          inspectHarnessInstallation(input),
        ]);
        return success(
          Object.freeze({ discovery, installation: installation.disposition }),
        );
      } catch {
        return failure(diagnostic("unavailable", "harness.unavailable"));
      }
    },
    uninstallHarness: ({ apply, harness }) =>
      manage("uninstall", harness, apply),
  };
  return Object.freeze(services);
};
