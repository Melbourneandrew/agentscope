import type { RedactedCanonicalTrace } from "@agentscope/protocol";

import {
  prepareDestinationReporter,
  resolveDestinationConnection,
  type DestinationDescriptor,
} from "./descriptor.js";
import { createDestinationConnectionId } from "./identity.js";
import { createReporterDeadline, type ReporterDeadline } from "./deadline.js";
import {
  invokeReporter,
  type Reporter,
  type ReporterReceipt,
} from "./reporter.js";
import {
  bindDestinationTransport,
  type DestinationTransportExecutor,
} from "./transport.js";

const TEST_CONNECTION_ID = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);

export type DestinationReporterTestPreparation = Readonly<{
  descriptor: DestinationDescriptor;
  settings: unknown;
  credentials: unknown;
  executor: DestinationTransportExecutor;
}>;

export const prepareDestinationReporterForTesting = (
  input: DestinationReporterTestPreparation,
): Reporter => {
  const prepared = resolveDestinationConnection(input.descriptor, {
    connectionId: TEST_CONNECTION_ID,
    settings: input.settings,
  });
  if (prepared.endpoint === null)
    throw new Error("destination.testing.remote-required");
  return prepareDestinationReporter(prepared, {
    credentials: input.credentials,
    transport: bindDestinationTransport(prepared.endpoint, input.executor),
  });
};

export type DestinationReporterTestAttempt = Readonly<{
  traces: readonly [RedactedCanonicalTrace, ...RedactedCanonicalTrace[]];
  signal?: AbortSignal;
  deadline?: ReporterDeadline;
  timeoutMilliseconds?: number;
  admissionTimeUnixNano?: string;
}>;

export const invokeDestinationReporterForTesting = (
  reporter: Reporter,
  input: DestinationReporterTestAttempt,
): Promise<ReporterReceipt> =>
  invokeReporter(reporter, {
    traces: input.traces,
    signal: input.signal ?? new AbortController().signal,
    deadline:
      input.deadline ??
      createReporterDeadline(input.timeoutMilliseconds ?? 1_000),
    admissionTimeUnixNano: input.admissionTimeUnixNano ?? "1",
  });
