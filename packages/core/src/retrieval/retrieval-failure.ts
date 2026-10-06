import type { RetrieverFailureCode } from "@agentscope/destinations-core";

export type CoreRetrievalFailureCode = RetrieverFailureCode;
export type CoreRetrievalFailure = Readonly<{
  ok: false;
  code: CoreRetrievalFailureCode;
  retryAfterMilliseconds?: number;
  failurePhase?: "prepare-retriever" | "invoke-get";
}>;

export const failure = (
  code: CoreRetrievalFailureCode,
  retryAfterMilliseconds?: number,
  failurePhase?: CoreRetrievalFailure["failurePhase"],
): CoreRetrievalFailure =>
  Object.freeze({
    ok: false,
    code,
    ...(retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds }),
    ...(code === "unavailable" && failurePhase !== undefined
      ? { failurePhase }
      : {}),
  });
