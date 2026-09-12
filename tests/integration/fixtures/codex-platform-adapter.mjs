const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());

const token = /^[a-z][a-z0-9-]{0,63}$/u;
const digest = /^[a-f0-9]{64}$/u;

// This checksum-bound adapter translates observations only. It has no expected
// stimulus and cannot turn a missing Codex request or trace into passing data.
// eslint-disable-next-line complexity -- one closed checksum-bound observation grammar
export const translateCodexPlatformObservations = (input) => {
  if (
    !exactKeys(input, [
      "scenarioId",
      "modelRequest",
      "hooks",
      "search",
      "retrieval",
      "doctor",
      "uninstall",
    ]) ||
    typeof input.scenarioId !== "string" ||
    !token.test(input.scenarioId)
  )
    throw new Error("integration.codex.adapter-observation");
  const { modelRequest, hooks, search, retrieval, doctor, uninstall } = input;
  if (
    !exactKeys(modelRequest, [
      "bodyBytes",
      "bodySha256",
      "credentialHeaderCount",
      "method",
      "path",
      "promptOccurrenceCount",
      "promptSha256",
    ]) ||
    modelRequest.method !== "POST" ||
    modelRequest.path !== "/v1/responses" ||
    !Number.isSafeInteger(modelRequest.bodyBytes) ||
    modelRequest.bodyBytes < 1 ||
    modelRequest.bodyBytes > 1024 * 1024 ||
    typeof modelRequest.bodySha256 !== "string" ||
    !digest.test(modelRequest.bodySha256) ||
    typeof modelRequest.promptSha256 !== "string" ||
    !digest.test(modelRequest.promptSha256) ||
    modelRequest.promptOccurrenceCount !== 1 ||
    modelRequest.credentialHeaderCount !== 0 ||
    !Array.isArray(hooks) ||
    hooks.length !== 3 ||
    hooks.some(
      (hook, index) =>
        !exactKeys(hook, [
          "recordVersion",
          "event",
          "sessionId",
          "turnId",
          "model",
          "inputBytes",
          "inputSha256",
          "launcherGid",
          "launcherExitCode",
          "launcherMode",
          "launcherPathSha256",
          "launcherSha256",
          "launcherStdoutBytes",
          "launcherStderrBytes",
          "launcherUid",
        ]) ||
        hook.recordVersion !== 1 ||
        hook.event !== ["SessionStart", "Stop", "SessionEnd"][index] ||
        typeof hook.sessionId !== "string" ||
        hook.sessionId.length < 1 ||
        hook.sessionId.length > 256 ||
        (index === 1
          ? typeof hook.turnId !== "string" || hook.turnId.length < 1
          : hook.turnId !== null) ||
        (hook.model !== null &&
          (typeof hook.model !== "string" || hook.model.length > 256)) ||
        !Number.isSafeInteger(hook.inputBytes) ||
        hook.inputBytes < 1 ||
        hook.inputBytes > 65_536 ||
        typeof hook.inputSha256 !== "string" ||
        !digest.test(hook.inputSha256) ||
        typeof hook.launcherPathSha256 !== "string" ||
        !digest.test(hook.launcherPathSha256) ||
        typeof hook.launcherSha256 !== "string" ||
        !digest.test(hook.launcherSha256) ||
        !Number.isSafeInteger(hook.launcherMode) ||
        (hook.launcherMode & 0o111) === 0 ||
        hook.launcherMode > 0o7777 ||
        hook.launcherUid !== 0 ||
        hook.launcherGid !== 0 ||
        hook.launcherExitCode !== 0 ||
        hook.launcherStdoutBytes !== 0 ||
        hook.launcherStderrBytes !== 0,
    ) ||
    new Set(hooks.map(({ sessionId }) => sessionId)).size !== 1 ||
    new Set(hooks.map(({ launcherPathSha256 }) => launcherPathSha256)).size !==
      1 ||
    new Set(hooks.map(({ launcherSha256 }) => launcherSha256)).size !== 1 ||
    !exactKeys(search, ["completion", "harness", "spanCount", "traceId"]) ||
    search.completion !== "complete" ||
    search.harness !== "codex" ||
    !Number.isSafeInteger(search.spanCount) ||
    search.spanCount < 1 ||
    search.spanCount > 256 ||
    typeof search.traceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(search.traceId) ||
    !exactKeys(retrieval, ["completion", "resourceSpanCount", "traceId"]) ||
    retrieval.completion !== "complete" ||
    retrieval.traceId !== search.traceId ||
    !Number.isSafeInteger(retrieval.resourceSpanCount) ||
    retrieval.resourceSpanCount < 1 ||
    retrieval.resourceSpanCount > 256 ||
    !exactKeys(doctor, ["completion"]) ||
    doctor.completion !== "complete" ||
    !exactKeys(uninstall, ["completion"]) ||
    uninstall.completion !== "complete"
  )
    throw new Error("integration.codex.adapter-observation");
  return Object.freeze({
    scenarioId: input.scenarioId,
    modelRequest: Object.freeze({ ...modelRequest }),
    hooks: Object.freeze(hooks.map((hook) => Object.freeze({ ...hook }))),
    search: Object.freeze({ ...search }),
    retrieval: Object.freeze({ ...retrieval }),
    doctor: Object.freeze({ ...doctor }),
    uninstall: Object.freeze({ ...uninstall }),
  });
};
