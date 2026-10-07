import type { CoreRetrievalFailure } from "@agentscope/core/retrieval-orchestration";

import type { CliDiagnostic } from "./cli-contract.js";
import {
  diagnostic,
  missingConfiguration,
  unavailable,
} from "./credential-configuration-service.js";

const retrievalDiagnostics = Object.freeze({
  "deadline-exceeded": ["unavailable", "traces.deadline-exceeded"],
  forbidden: ["permission-denied", "traces.forbidden"],
  "incompatible-trace": ["unavailable", "traces.incompatible-trace"],
  "invalid-query": ["usage", "traces.invalid-query"],
  "malformed-response": ["unavailable", "traces.malformed-response"],
  "not-found": ["not-found", "traces.not-found"],
  "rate-limited": ["unavailable", "traces.rate-limited"],
  "retrieval-unsupported": ["unavailable", "traces.retrieval-unsupported"],
  unauthorized: ["permission-denied", "traces.unauthorized"],
  unavailable: ["unavailable", "traces.unavailable"],
  "unknown-connection": ["not-found", "traces.destination-unknown"],
} as const satisfies Readonly<
  Record<
    CoreRetrievalFailure["code"],
    readonly [CliDiagnostic["category"], string]
  >
>);

export const retrievalDiagnostic = (
  failure: CoreRetrievalFailure,
): CliDiagnostic => {
  const [category, code] = retrievalDiagnostics[failure.code];
  const phase =
    failure.code === "unavailable" ? failure.failurePhase : undefined;
  const facts = {
    ...(failure.retryAfterMilliseconds === undefined
      ? {}
      : { retryAfterMilliseconds: failure.retryAfterMilliseconds }),
    ...(phase === "prepare-retriever" || phase === "invoke-get"
      ? {
          retrieverPreparationFailed: phase === "prepare-retriever",
          retrieverInvocationFailed: phase === "invoke-get",
        }
      : {}),
    ...(phase === "invoke-get" &&
    failure.adapterFailureObservation !== undefined
      ? {
          retrieverReportedStage: failure.adapterFailureObservation.stage,
          retrieverCutoffExpired:
            failure.adapterFailureObservation.cutoffExpired,
          retrieverWorkerJoined: failure.adapterFailureObservation.workerJoined,
          retrieverWatchdogJoined:
            failure.adapterFailureObservation.watchdogJoined,
          retrieverLeaseReleased:
            failure.adapterFailureObservation.leaseReleased,
        }
      : {}),
  };
  return diagnostic(
    category,
    code,
    Object.keys(facts).length ? facts : undefined,
  );
};

const preparationDiagnostics = Object.freeze({
  "core.configuration.invalid": unavailable,
  "core.configuration.missing": missingConfiguration,
  "core.configuration.unavailable": unavailable,
  "core.configuration.unsupported": unavailable,
  "deadline-exceeded": diagnostic("unavailable", "traces.deadline-exceeded"),
});

export const retrievalPreparationDiagnostic = (
  code: keyof typeof preparationDiagnostics,
): CliDiagnostic => preparationDiagnostics[code];
