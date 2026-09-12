const assert = (condition, code) => {
  if (!condition) throw new Error(`integration.codex.oracle-${code}`);
};

export const correlateCodexPlatformObservations = (
  observation,
  { artifactFileName, expectedPromptSha256, scenarioId },
) => {
  assert(observation.scenarioId === scenarioId, "scenario");
  assert(
    expectedPromptSha256 ===
      "8fa471336a2b22881c19fc825a447c7f6c16c6f38ed937f7c0ecdf15d858276c",
    "stimulus",
  );
  const request = observation.modelRequests[0];
  assert(
    observation.promptSha256 === expectedPromptSha256 &&
      observation.modelRequests.length === 1 &&
      request.method === "POST" &&
      request.path === "/v1/responses" &&
      request.model === "fixture-model" &&
      request.promptOccurrenceCount === 1 &&
      request.credentialHeaderCount === 0,
    "model-request",
  );
  assert(
    observation.search.completion === "complete" &&
      observation.search.harness === "codex" &&
      observation.search.spanCount === 2 &&
      /^[a-f0-9]{32}$/u.test(observation.search.traceId) &&
      observation.retrieval.completion === "complete" &&
      observation.search.traceId === observation.retrieval.traceId &&
      observation.retrieval.resourceSpanCount >= 1 &&
      observation.retrieval.parentLinked === true &&
      JSON.stringify(observation.retrieval.spanNames) ===
        JSON.stringify(["codex.turn", "codex.response"]) &&
      observation.retrieval.modelName === request.model &&
      typeof observation.retrieval.sessionId === "string" &&
      observation.retrieval.sessionId.length > 0,
    "trace",
  );
  assert(
    observation.doctor.completion === "complete" &&
      observation.doctor.errors === 0 &&
      observation.uninstall.completion === "complete" &&
      observation.uninstall.installedStatus.installation === "unchanged" &&
      observation.uninstall.installedStatus.configurationPresentCount === 1 &&
      observation.uninstall.uninstall.changedTargetCount === 1 &&
      observation.uninstall.uninstall.disposition === "committed" &&
      observation.uninstall.uninstalledStatus.installation === "ready" &&
      observation.uninstall.uninstalledStatus.configurationPresentCount === 0,
    "lifecycle",
  );
  return Object.freeze({
    evidenceVersion: 1,
    resultStatus: "complete",
    scenarioId,
    artifactFileName,
    lifecycle: [
      "install",
      "configure",
      "hook",
      "execute",
      "export",
      "retrieve",
      "uninstall",
    ],
    certificationReadiness: null,
    eventKinds: ["hook", "model", "destination"],
    harnessObservation: {
      observationVersion: 1,
      kind: "codex-tui-trace",
      modelRequestBodySha256: request.bodySha256,
      traceId: observation.search.traceId,
      resourceSpanCount: observation.retrieval.resourceSpanCount,
      spanNames: observation.retrieval.spanNames,
      parentLinked: observation.retrieval.parentLinked,
      doctorErrors: observation.doctor.errors,
      uninstallDisposition: observation.uninstall.uninstall.disposition,
    },
    modelLedger: {
      ledgerVersion: 1,
      scenarioId,
      entries: [
        {
          routeId: "codex-tui-responses",
          provider: "openai",
          method: request.method,
          path: request.path,
          bodyBytes: request.bodyBytes,
        },
      ],
    },
    destinationLedger: {
      ledgerVersion: 1,
      scenarioId,
      ingestion: [],
      retrieval: [
        {
          operation: "search",
          method: "CLI",
          path: "/traces/search",
          bodyBytes: 0,
          outcome: "accepted",
        },
        {
          operation: "get",
          method: "CLI",
          path: "/traces/get",
          bodyBytes: 0,
          outcome: "accepted",
        },
      ],
    },
  });
};
