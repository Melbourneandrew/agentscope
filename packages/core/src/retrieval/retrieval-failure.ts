import type {
  RetrieverFailure,
  RetrieverFailureCode,
} from "@agentscope/destinations-core";

export type CoreRetrievalFailureCode = RetrieverFailureCode;
export type CoreRetrievalFailure = Readonly<{
  ok: false;
  code: CoreRetrievalFailureCode;
  retryAfterMilliseconds?: number;
  failurePhase?: "prepare-retriever" | "invoke-get";
  adapterFailureObservation?: RetrieverFailure["adapterFailureObservation"];
}>;

export const failure = (
  code: CoreRetrievalFailureCode,
  retryAfterMilliseconds?: number,
  failurePhase?: CoreRetrievalFailure["failurePhase"],
  observation?: RetrieverFailure["adapterFailureObservation"],
): CoreRetrievalFailure =>
  Object.freeze({
    ok: false,
    code,
    ...(retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds }),
    ...(code === "unavailable" && failurePhase !== undefined
      ? { failurePhase }
      : {}),
    ...(code === "unavailable" &&
    failurePhase === "invoke-get" &&
    observation !== undefined
      ? {
          adapterFailureObservation: Object.freeze({
            stage: observation.stage,
            cutoffExpired: observation.cutoffExpired,
            workerJoined: observation.workerJoined,
            watchdogJoined: observation.watchdogJoined,
            leaseReleased: observation.leaseReleased,
          }),
        }
      : {}),
  });
