const exactKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const token = /^[a-z][a-z0-9-]{0,63}$/u;
const digest = /^[a-f0-9]{64}$/u;
const boundedString = (value, maximum = 4_096) =>
  typeof value === "string" && value.length <= maximum;
const countValue = (value, expected) => {
  if (value === expected) return 1;
  if (Array.isArray(value))
    return value.reduce(
      (count, child) => count + countValue(child, expected),
      0,
    );
  if (typeof value === "object" && value !== null)
    return Object.values(value).reduce(
      (count, child) => count + countValue(child, expected),
      0,
    );
  return 0;
};

const translateModelRequest = (request, prompt) => {
  if (typeof request !== "object" || request === null || Array.isArray(request))
    throw new Error("integration.codex.adapter-observation");
  const bodyText =
    typeof request.body === "string"
      ? request.body
      : typeof request.body?.string === "string"
        ? request.body.string
        : typeof request.body?.json === "string"
          ? request.body.json
          : undefined;
  if (
    !boundedString(request.method, 16) ||
    !boundedString(request.path, 1_024) ||
    bodyText === undefined ||
    Buffer.byteLength(bodyText) > 1024 * 1024
  )
    throw new Error("integration.codex.adapter-observation");
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error("integration.codex.adapter-observation");
  }
  const headerNames = Array.isArray(request.headers)
    ? request.headers.map(({ name }) => name)
    : typeof request.headers === "object" && request.headers !== null
      ? Object.keys(request.headers)
      : [];
  if (
    headerNames.length > 64 ||
    headerNames.some((name) => !boundedString(name, 128) || name.length < 1)
  )
    throw new Error("integration.codex.adapter-observation");
  return Object.freeze({
    method: request.method,
    path: request.path,
    bodyBytes: Buffer.byteLength(bodyText),
    bodySha256: createHash("sha256").update(bodyText).digest("hex"),
    model: typeof body?.model === "string" ? body.model : null,
    promptOccurrenceCount: countValue(body, prompt),
    credentialHeaderCount: headerNames.filter((name) =>
      /^(?:authorization|api-key|x-api-key)$/iu.test(name),
    ).length,
  });
};

// The adapter translates bounded native shapes only. Expected outcomes belong
// exclusively to the independently checksum-bound oracle.
// eslint-disable-next-line complexity -- one closed all-record native-shape translation grammar
export const translateCodexPlatformObservations = (input) => {
  if (
    !exactKeys(input, [
      "scenarioId",
      "prompt",
      "promptSha256",
      "modelRequests",
      "search",
      "retrieval",
      "doctor",
      "uninstall",
    ]) ||
    !token.test(input.scenarioId) ||
    !boundedString(input.prompt, 1_024) ||
    !digest.test(input.promptSha256) ||
    !Array.isArray(input.modelRequests) ||
    input.modelRequests.length > 8
  )
    throw new Error("integration.codex.adapter-observation");
  const modelRequests = input.modelRequests.map((request) =>
    translateModelRequest(request, input.prompt),
  );
  const { search, retrieval, doctor, uninstall } = input;
  if (
    !exactKeys(search, ["completion", "harness", "spanCount", "traceId"]) ||
    !boundedString(search.completion, 32) ||
    !boundedString(search.harness, 64) ||
    !Number.isSafeInteger(search.spanCount) ||
    search.spanCount < 0 ||
    search.spanCount > 256 ||
    !boundedString(search.traceId, 64) ||
    !exactKeys(retrieval, [
      "completion",
      "modelName",
      "parentLinked",
      "resourceSpanCount",
      "sessionId",
      "spanNames",
      "traceId",
    ]) ||
    !boundedString(retrieval.completion, 32) ||
    !boundedString(retrieval.traceId, 64) ||
    !Number.isSafeInteger(retrieval.resourceSpanCount) ||
    retrieval.resourceSpanCount < 0 ||
    retrieval.resourceSpanCount > 256 ||
    typeof retrieval.parentLinked !== "boolean" ||
    !Array.isArray(retrieval.spanNames) ||
    retrieval.spanNames.length > 256 ||
    retrieval.spanNames.some((name) => !boundedString(name, 256)) ||
    !(
      retrieval.modelName === null || boundedString(retrieval.modelName, 256)
    ) ||
    !(
      retrieval.sessionId === null || boundedString(retrieval.sessionId, 256)
    ) ||
    !exactKeys(doctor, ["completion", "errors", "findingCount", "warnings"]) ||
    !boundedString(doctor.completion, 32) ||
    !Number.isSafeInteger(doctor.errors) ||
    !Number.isSafeInteger(doctor.warnings) ||
    !Number.isSafeInteger(doctor.findingCount) ||
    doctor.findingCount < 0 ||
    doctor.findingCount > 1_159 ||
    !exactKeys(uninstall, [
      "completion",
      "installedStatus",
      "uninstall",
      "uninstalledStatus",
    ]) ||
    !boundedString(uninstall.completion, 32) ||
    !exactKeys(uninstall.installedStatus, [
      "configurationPresentCount",
      "installation",
    ]) ||
    !boundedString(uninstall.installedStatus.installation, 32) ||
    !Number.isSafeInteger(
      uninstall.installedStatus.configurationPresentCount,
    ) ||
    !exactKeys(uninstall.uninstall, ["changedTargetCount", "disposition"]) ||
    !boundedString(uninstall.uninstall.disposition, 32) ||
    !Number.isSafeInteger(uninstall.uninstall.changedTargetCount) ||
    !exactKeys(uninstall.uninstalledStatus, [
      "configurationPresentCount",
      "installation",
    ]) ||
    !boundedString(uninstall.uninstalledStatus.installation, 32) ||
    !Number.isSafeInteger(uninstall.uninstalledStatus.configurationPresentCount)
  )
    throw new Error("integration.codex.adapter-observation");
  return Object.freeze({
    scenarioId: input.scenarioId,
    promptSha256: input.promptSha256,
    modelRequests: Object.freeze(modelRequests),
    search: Object.freeze({ ...search }),
    retrieval: Object.freeze({
      ...retrieval,
      spanNames: Object.freeze([...retrieval.spanNames]),
    }),
    doctor: Object.freeze({ ...doctor }),
    uninstall: Object.freeze({
      completion: uninstall.completion,
      installedStatus: Object.freeze({ ...uninstall.installedStatus }),
      uninstall: Object.freeze({ ...uninstall.uninstall }),
      uninstalledStatus: Object.freeze({ ...uninstall.uninstalledStatus }),
    }),
  });
};
import { createHash } from "node:crypto";
