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
      "search",
      "retrieval",
      "doctor",
      "uninstall",
    ]) ||
    typeof input.scenarioId !== "string" ||
    !token.test(input.scenarioId)
  )
    throw new Error("integration.codex.adapter-observation");
  const { modelRequest, search, retrieval, doctor, uninstall } = input;
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
    !exactKeys(search, ["completion", "harness", "spanCount", "traceId"]) ||
    search.completion !== "complete" ||
    search.harness !== "codex" ||
    !Number.isSafeInteger(search.spanCount) ||
    search.spanCount < 1 ||
    search.spanCount > 256 ||
    typeof search.traceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(search.traceId) ||
    !exactKeys(retrieval, [
      "completion",
      "parentLinked",
      "resourceSpanCount",
      "spanNames",
      "traceId",
    ]) ||
    retrieval.completion !== "complete" ||
    retrieval.traceId !== search.traceId ||
    !Number.isSafeInteger(retrieval.resourceSpanCount) ||
    retrieval.resourceSpanCount < 1 ||
    retrieval.resourceSpanCount > 256 ||
    retrieval.parentLinked !== true ||
    JSON.stringify(retrieval.spanNames) !==
      JSON.stringify(["codex.turn", "codex.response"]) ||
    !exactKeys(doctor, ["completion", "errors", "findingCount", "warnings"]) ||
    doctor.completion !== "complete" ||
    doctor.errors !== 0 ||
    !Number.isSafeInteger(doctor.warnings) ||
    doctor.warnings < 0 ||
    !Number.isSafeInteger(doctor.findingCount) ||
    doctor.findingCount < 1 ||
    doctor.findingCount > 1_159 ||
    !exactKeys(uninstall, [
      "completion",
      "installedStatus",
      "uninstall",
      "uninstalledStatus",
    ]) ||
    uninstall.completion !== "complete"
  )
    throw new Error("integration.codex.adapter-observation");
  if (
    !exactKeys(uninstall.installedStatus, [
      "configurationPresentCount",
      "installation",
    ]) ||
    uninstall.installedStatus.installation !== "unchanged" ||
    uninstall.installedStatus.configurationPresentCount !== 1 ||
    !exactKeys(uninstall.uninstall, ["changedTargetCount", "disposition"]) ||
    uninstall.uninstall.changedTargetCount !== 1 ||
    uninstall.uninstall.disposition !== "committed" ||
    !exactKeys(uninstall.uninstalledStatus, [
      "configurationPresentCount",
      "installation",
    ]) ||
    uninstall.uninstalledStatus.installation !== "ready" ||
    uninstall.uninstalledStatus.configurationPresentCount !== 0
  )
    throw new Error("integration.codex.adapter-observation");
  return Object.freeze({
    scenarioId: input.scenarioId,
    modelRequest: Object.freeze({ ...modelRequest }),
    search: Object.freeze({ ...search }),
    retrieval: Object.freeze({ ...retrieval }),
    doctor: Object.freeze({ ...doctor }),
    uninstall: Object.freeze({ ...uninstall }),
  });
};
