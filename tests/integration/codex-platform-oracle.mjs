import { createHash } from "node:crypto";

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
  assert(
    observation.modelRequest.promptSha256 === expectedPromptSha256 &&
      observation.modelRequest.promptOccurrenceCount === 1 &&
      observation.modelRequest.credentialHeaderCount === 0,
    "model-request",
  );
  assert(
    JSON.stringify(observation.hooks.map(({ event }) => event)) ===
      JSON.stringify(["SessionStart", "Stop", "SessionEnd"]) &&
      new Set(observation.hooks.map(({ sessionId }) => sessionId)).size === 1 &&
      observation.hooks.every(
        ({ launcherExitCode, launcherStdoutBytes, launcherStderrBytes }) =>
          launcherExitCode === 0 &&
          launcherStdoutBytes === 0 &&
          launcherStderrBytes === 0,
      ),
    "hook-lifecycle",
  );
  assert(observation.search.traceId === observation.retrieval.traceId, "trace");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
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
      hookEvents: observation.hooks.map(({ event }) => event),
      sessionSha256: digest(observation.hooks[0].sessionId),
      turnSha256: digest(observation.hooks[1].turnId),
      modelRequestBodySha256: observation.modelRequest.bodySha256,
      traceId: observation.search.traceId,
      resourceSpanCount: observation.retrieval.resourceSpanCount,
    },
    modelLedger: {
      ledgerVersion: 1,
      scenarioId,
      entries: [
        {
          routeId: "codex-tui-responses",
          provider: "openai",
          method: observation.modelRequest.method,
          path: observation.modelRequest.path,
          bodyBytes: observation.modelRequest.bodyBytes,
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
