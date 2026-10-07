import { describe, expect, it } from "vitest";

import { cliDiagnosticSchema } from "./cli-contract.js";
import {
  retrievalDiagnostic,
  retrievalPreparationDiagnostic,
} from "./retrieval-diagnostics.js";

describe("fixed retrieval diagnostics preserve failure and disclose only owned phase", () => {
  it("projects reported unavailable observations into only existing bounded scalar facts", () => {
    const adapterFailureObservation = Object.freeze({
      stage: 11 as const,
      cutoffExpired: false,
      workerJoined: true,
      watchdogJoined: false,
      leaseReleased: null,
    });
    const result = retrievalDiagnostic({
      ok: false,
      code: "unavailable",
      failurePhase: "invoke-get",
      adapterFailureObservation,
    });
    expect(result.facts).toEqual({
      retrieverPreparationFailed: false,
      retrieverInvocationFailed: true,
      retrieverReportedStage: 11,
      retrieverCutoffExpired: false,
      retrieverWorkerJoined: true,
      retrieverWatchdogJoined: false,
      retrieverLeaseReleased: null,
    });
    expect(cliDiagnosticSchema.safeParse(result).success).toBe(true);
    expect(
      retrievalDiagnostic({
        ok: false,
        code: "deadline-exceeded",
        adapterFailureObservation,
      }).facts,
    ).toBeUndefined();
  });
  it.each(["prepare-retriever", "invoke-get"] as const)(
    "projects %s through existing boolean facts without reflecting a string",
    (failurePhase) => {
      const value = retrievalDiagnostic({
        ok: false,
        code: "unavailable",
        failurePhase,
      });
      expect(value).toEqual({
        category: "unavailable",
        code: "traces.unavailable",
        facts: {
          retrieverPreparationFailed: failurePhase === "prepare-retriever",
          retrieverInvocationFailed: failurePhase === "invoke-get",
        },
      });
      expect(cliDiagnosticSchema.safeParse(value).success).toBe(true);
      expect(JSON.stringify(value)).not.toContain(failurePhase);
    },
  );

  it("does not invent a phase for an unclassified unavailable result", () => {
    expect(retrievalDiagnostic({ ok: false, code: "unavailable" })).toEqual({
      category: "unavailable",
      code: "traces.unavailable",
    });
  });

  it("keeps rate limit and original deadline diagnostics distinct", () => {
    expect(
      retrievalDiagnostic({
        ok: false,
        code: "rate-limited",
        retryAfterMilliseconds: 17,
      }),
    ).toEqual({
      category: "unavailable",
      code: "traces.rate-limited",
      facts: { retryAfterMilliseconds: 17 },
    });
    expect(
      retrievalDiagnostic({ ok: false, code: "deadline-exceeded" }),
    ).toEqual({
      category: "unavailable",
      code: "traces.deadline-exceeded",
    });
  });

  it("does not relabel configuration preparation as retriever preparation", () => {
    expect(
      retrievalPreparationDiagnostic("core.configuration.unavailable"),
    ).toEqual({
      category: "unavailable",
      code: "configuration.unavailable",
    });
    expect(retrievalPreparationDiagnostic("deadline-exceeded")).toEqual({
      category: "unavailable",
      code: "traces.deadline-exceeded",
    });
  });
});
