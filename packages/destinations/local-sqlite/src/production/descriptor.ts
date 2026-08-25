import { z } from "zod";

import {
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  reporterDeadlineRemainingMilliseconds,
  type DestinationDescriptor,
  type ReporterDeadline,
  type ReporterFactoryContext,
  type ReporterAttempt,
} from "@agentscope/destinations-core";

import { LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST } from "../native-support.js";
import {
  prepareLocalSqliteTrace,
  type LocalSqliteReporterPolicy,
} from "../reporter/transaction.js";
import { createLocalSqliteRetriever } from "../retriever/index.js";
import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  localSqliteLifecycleDeclaration,
} from "../lifecycle/capability.js";
import { MAXIMUM_REPORTER_CHILD_BATCH_PAYLOAD_BYTES } from "./reporter-child-protocol.js";
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

export const prepareLocalSqliteBatch = (
  traces: ReporterAttempt["traces"],
  admissionTimeUnixNano: string,
  remainingMilliseconds: () => number,
): readonly ReturnType<typeof prepareLocalSqliteTrace>[] | undefined => {
  const minimumRemaining =
    LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.minimumNativeChildBudgetMilliseconds +
    LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeTeardownReserveMilliseconds;
  const prepared: ReturnType<typeof prepareLocalSqliteTrace>[] = [];
  let aggregatePayloadBytes = 0;
  for (const trace of traces) {
    if (remainingMilliseconds() < minimumRemaining) return undefined;
    const value = prepareLocalSqliteTrace(trace, admissionTimeUnixNano);
    aggregatePayloadBytes += value.payloadBytes;
    if (
      aggregatePayloadBytes > MAXIMUM_REPORTER_CHILD_BATCH_PAYLOAD_BYTES ||
      remainingMilliseconds() < minimumRemaining
    )
      return undefined;
    prepared.push(value);
  }
  return Object.freeze(prepared);
};

const createProductionReporter = (
  context: ReporterFactoryContext<LocalSqliteDestinationSettings>,
  runtime: () => LocalSqliteProductionRuntime,
  lifecycleFingerprint: string,
) => {
  const policy = policyFor(context.settings);
  return createDestinationReporter({
    report: async (attempt) => {
      try {
        const remainingMilliseconds = () =>
          reporterDeadlineRemainingMilliseconds(attempt.deadline);
        const prepared = prepareLocalSqliteBatch(
          attempt.traces,
          attempt.admissionTimeUnixNano,
          remainingMilliseconds,
        );
        /* v8 ignore next -- the batch helper directly proves both pre/post
           preparation exhaustion branches before runtime delegation. */
        if (prepared === undefined) return createReporterReceipt("unavailable");
        return await runtime().reportPrepared({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          prepared,
          admissionTimeUnixNano: attempt.admissionTimeUnixNano,
          signal: attempt.signal,
          deadline: attempt.deadline,
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
      search: (plan, signal, deadline?: ReporterDeadline) => {
        /* v8 ignore next 2 -- Destinations Core always supplies its branded
           absolute deadline; malformed direct-port use is rejected defensively. */
        if (deadline === undefined)
          throw new Error("destination.local-sqlite.unavailable");
        return runtime().search({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          plan,
          signal,
          deadline,
        });
      },
      get: (plan, signal, deadline?: ReporterDeadline) => {
        /* v8 ignore next 2 -- Destinations Core always supplies its branded
           absolute deadline; malformed direct-port use is rejected defensively. */
        if (deadline === undefined)
          throw new Error("destination.local-sqlite.unavailable");
        return runtime().get({
          connectionId: context.connectionId,
          lifecycleFingerprint,
          policy,
          plan,
          signal,
          deadline,
        });
      },
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
