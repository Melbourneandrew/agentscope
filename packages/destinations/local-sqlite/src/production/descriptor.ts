import { z } from "zod";

import {
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  reporterDeadlineRemainingMilliseconds,
  type DestinationDescriptor,
  type ReporterFactoryContext,
} from "@agentscope/destinations-core";

import {
  prepareLocalSqliteTrace,
  type LocalSqliteReporterPolicy,
} from "../reporter/transaction.js";
import { createLocalSqliteRetriever } from "../retriever/index.js";
import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  localSqliteLifecycleDeclaration,
} from "../lifecycle/capability.js";
import type { LocalSqliteExecutionPolicy } from "./sqlite-port.js";
import { getLocalSqliteProductionRuntime } from "./runtime.js";
import type { LocalSqliteProductionRuntime } from "./runtime.js";

export type LocalSqliteDestinationSettings = Readonly<{
  maximumAgeNanoseconds: string;
  maximumPayloadBytes: number;
  maximumTraceCount: number;
}>;

const settingsSchema = z.strictObject({
  maximumAgeNanoseconds: z.string().regex(/^[1-9][0-9]{0,16}$/),
  maximumPayloadBytes: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024 * 1024),
  maximumTraceCount: z.number().int().min(1).max(1_000_000),
});
void settingsSchema.shape;

const policyFor = (
  settings: LocalSqliteDestinationSettings,
): LocalSqliteReporterPolicy & LocalSqliteExecutionPolicy =>
  Object.freeze({
    maximumAgeNanoseconds: settings.maximumAgeNanoseconds,
    maximumPayloadBytes: settings.maximumPayloadBytes,
    maximumTraceCount: settings.maximumTraceCount,
  });

const createProductionReporter = (
  context: ReporterFactoryContext<LocalSqliteDestinationSettings>,
  runtime: () => LocalSqliteProductionRuntime,
  lifecycleFingerprint: string,
) => {
  const policy = policyFor(context.settings);
  return createDestinationReporter({
    report: async (attempt) => {
      try {
        const prepared = attempt.traces.map((trace) =>
          prepareLocalSqliteTrace(trace, attempt.admissionTimeUnixNano),
        );
        return await runtime().reportPrepared({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          prepared,
          admissionTimeUnixNano: attempt.admissionTimeUnixNano,
          signal: attempt.signal,
          remainingMilliseconds: () =>
            reporterDeadlineRemainingMilliseconds(attempt.deadline),
        });
      } catch {
        return createReporterReceipt("unavailable");
      }
    },
  });
};

const createProductionRetriever = (
  context: ReporterFactoryContext<LocalSqliteDestinationSettings>,
  runtime: () => LocalSqliteProductionRuntime,
  lifecycleFingerprint: string,
) => {
  const policy = policyFor(context.settings);
  return createLocalSqliteRetriever(
    Object.freeze({
      search: (plan, signal) =>
        runtime().search({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          plan,
          signal,
        }),
      get: (plan, signal) =>
        runtime().get({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          plan,
          signal,
        }),
    }),
  );
};

const defineLocalSqliteProductionDescriptor = (
  runtime: () => LocalSqliteProductionRuntime,
): DestinationDescriptor<LocalSqliteDestinationSettings> => {
  let lifecycleFingerprint = "";
  const descriptor = defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    commandName: "local-sqlite",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {
      maximumAgeNanoseconds: "2592000000000000",
      maximumPayloadBytes: 1_073_741_824,
      maximumTraceCount: 100_000,
    },
    credentialSlots: [],
    documentationPath: "/docs/cli/destination/configure",
    deliveryIdentitySupport: "duplicates-possible",
    transport: { kind: "local" },
    createReporter: (context) =>
      createProductionReporter(context, runtime, lifecycleFingerprint),
    createRetriever: (context) =>
      createProductionRetriever(context, runtime, lifecycleFingerprint),
    retrievalOrdering: "start-time-desc-trace-id-asc",
    localResourceLifecycle: localSqliteLifecycleDeclaration,
  });
  lifecycleFingerprint = descriptor.localResourceLifecycle!.fingerprint;
  return descriptor;
};

export const localSqliteDestinationDescriptor: DestinationDescriptor<LocalSqliteDestinationSettings> =
  defineLocalSqliteProductionDescriptor(getLocalSqliteProductionRuntime);

export const createLocalSqliteDestinationDescriptorForTesting = (
  runtime: LocalSqliteProductionRuntime,
): DestinationDescriptor<LocalSqliteDestinationSettings> =>
  defineLocalSqliteProductionDescriptor(() => runtime);
