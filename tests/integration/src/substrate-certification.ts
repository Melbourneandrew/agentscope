import { createHash } from "node:crypto";

export const SUBSTRATE_CERTIFICATION_CASES = Object.freeze([
  "wrong-argv",
  "wrong-environment",
  "wrong-cwd",
  "missing-hook",
  "leaked-child",
  "unbounded-output",
  "false-success",
  "mixed-artifact-digest",
  "public-egress",
  "credential-presence",
  "cleanup-failure",
] as const);

export type SubstrateCertificationCase =
  (typeof SUBSTRATE_CERTIFICATION_CASES)[number];

export const parseSubstrateCertificationCaseValue = (
  value: string | undefined,
): SubstrateCertificationCase | undefined => {
  if (value === undefined) return undefined;
  if (
    !SUBSTRATE_CERTIFICATION_CASES.includes(value as SubstrateCertificationCase)
  )
    throw new Error("integration.certification.request");
  return value as SubstrateCertificationCase;
};

export const SUBSTRATE_CERTIFICATION_PREDICATES = Object.freeze({
  "wrong-argv": "request-argv-mismatch",
  "wrong-environment": "request-environment-mismatch",
  "wrong-cwd": "request-cwd-mismatch",
  "missing-hook": "lifecycle-hook-missing",
  "leaked-child": "containment-intervention",
  "unbounded-output": "output-limit",
  "false-success": "incomplete-evidence",
  "mixed-artifact-digest": "artifact-digest-mismatch",
  "public-egress": "egress-capable-network",
  "credential-presence": "credential-environment",
  "cleanup-failure": "cleanup-incomplete",
} satisfies Readonly<Record<SubstrateCertificationCase, string>>);

export const SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES = Object.freeze({
  "wrong-argv": "integration.controller.unsettled-operation",
  "wrong-environment": "integration.certification.wrong-environment",
  "wrong-cwd": "integration.certification.wrong-cwd",
  "missing-hook": "integration.controller.unsettled-operation",
  "leaked-child": "integration.controller.unsettled-operation",
  "unbounded-output": "integration.controller.unsettled-operation",
  "false-success": "integration.certification.false-success",
  "mixed-artifact-digest": "integration.certification.mixed-artifact-digest",
  "public-egress": "integration.certification.public-egress",
  "credential-presence": "integration.controller.provider-credentials",
  "cleanup-failure": "integration.certification.cleanup-failure",
} satisfies Readonly<Record<SubstrateCertificationCase, string>>);

export const leakedChildReadinessIsValid = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([
      "certificationCase",
      "challengeSha256",
      "readinessVersion",
    ]) &&
  "readinessVersion" in value &&
  value.readinessVersion === 1 &&
  "certificationCase" in value &&
  value.certificationCase === "leaked-child" &&
  "challengeSha256" in value &&
  typeof value.challengeSha256 === "string" &&
  /^sha256:[a-f0-9]{64}$/u.test(value.challengeSha256);

export const certificationFailureAuthorityIsValid = (input: {
  readonly certificationCase: unknown;
  readonly certificationPredicate: unknown;
  readonly certificationReadiness: unknown;
  readonly primaryFailure: unknown;
}): boolean => {
  if (input.certificationCase === null)
    return (
      input.certificationPredicate === null &&
      input.certificationReadiness === null
    );
  if (
    typeof input.certificationCase !== "string" ||
    !Object.hasOwn(SUBSTRATE_CERTIFICATION_PREDICATES, input.certificationCase)
  )
    return false;
  const certificationCase =
    input.certificationCase as SubstrateCertificationCase;
  return (
    input.certificationPredicate ===
      SUBSTRATE_CERTIFICATION_PREDICATES[certificationCase] &&
    input.primaryFailure ===
      SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES[certificationCase] &&
    (certificationCase === "leaked-child"
      ? leakedChildReadinessIsValid(input.certificationReadiness)
      : input.certificationReadiness === null)
  );
};

export const leakedChildReadinessWasObserved = (input: {
  readonly certificationReadiness: unknown;
  readonly fixtureCaptured: unknown;
  readonly fixtureResultStatus: unknown;
}): boolean =>
  leakedChildReadinessIsValid(input.certificationReadiness) &&
  input.fixtureCaptured === true &&
  input.fixtureResultStatus === "complete";

export type SubstrateCertificationRequest = Readonly<
  | { kind: "none" }
  | { kind: "replay"; ordinal: 1 | 2 | 3 }
  | { case: SubstrateCertificationCase; kind: "negative" }
>;

const ownString = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor))
    throw new Error("integration.certification.request");
  if (descriptor.value === undefined) return undefined;
  if (typeof descriptor.value !== "string")
    throw new Error("integration.certification.request");
  return descriptor.value;
};

export const parseSubstrateCertificationRequest = (
  environment: Readonly<NodeJS.ProcessEnv>,
  hostKind: "crabbox" | "github-hosted",
  mode: "candidate" | "crabbox" | "lifecycle",
): SubstrateCertificationRequest => {
  const replay = ownString(
    environment,
    "AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY",
  );
  const negativeCase = ownString(
    environment,
    "AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE",
  );
  if (replay === undefined && negativeCase === undefined)
    return Object.freeze({ kind: "none" });
  if (
    hostKind !== "github-hosted" ||
    mode !== "lifecycle" ||
    (replay !== undefined && negativeCase !== undefined)
  )
    throw new Error("integration.certification.request");
  if (replay !== undefined) {
    if (replay !== "1" && replay !== "2" && replay !== "3")
      throw new Error("integration.certification.request");
    return Object.freeze({
      kind: "replay",
      ordinal: Number(replay) as 1 | 2 | 3,
    });
  }
  const parsedCase = parseSubstrateCertificationCaseValue(negativeCase);
  if (parsedCase === undefined)
    throw new Error("integration.certification.request");
  return Object.freeze({
    case: parsedCase,
    kind: "negative",
  });
};

const providerCredentialNames = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CRABBOX_COORDINATOR_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "HCLOUD_TOKEN",
  "HETZNER_TOKEN",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OPENAI_API_KEY",
]);

const authorityBearingEnvironmentName =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|PUBLIC_KEY|SECRET|SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN|TOKEN)$/u;
const admittedControllerAuthorityNames = new Set([
  "AGENTSCOPE_VALIDATION_LEASE_TOKEN",
]);

export const providerCredentialEnvironmentIsClear = (
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean => {
  try {
    for (const name of Reflect.ownKeys(environment)) {
      if (typeof name !== "string") continue;
      if (
        providerCredentialNames.has(name) ||
        (authorityBearingEnvironmentName.test(name) &&
          !admittedControllerAuthorityNames.has(name))
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
};

const sha256Identity = /^sha256[-:][a-f0-9]{64}$/u;
const revision = /^[a-f0-9]{40}$/u;
const scenarioId = /^[a-z0-9][a-z0-9.-]{0,95}$/u;

export type SubstrateCertificationProjection = Readonly<{
  candidateBundleIdentity: string;
  manifestIdentity: string;
  selectedScenarioIds: readonly string[];
  scenarioResults: readonly Readonly<{
    cleanup: "complete";
    outcome: "passed";
    scenarioId: string;
  }>[];
  selectionIdentity: string;
}>;

export type SubstrateCertificationReceipt = Readonly<{
  candidateBundleIdentity: string;
  certificationReceiptVersion: 1;
  evidenceAuthority: "platform-certification-only";
  githubSha: string;
  manifestIdentity: string;
  replayOrdinal: 1 | 2 | 3;
  selectedScenarioIds: readonly string[];
  scenarioResults: readonly Readonly<{
    cleanup: "complete";
    outcome: "passed";
    scenarioId: string;
  }>[];
  selectionIdentity: string;
  stableIdentity: `sha256:${string}`;
}>;

const exactKeys = (value: object, keys: readonly string[]): boolean =>
  JSON.stringify(Reflect.ownKeys(value).sort()) ===
  JSON.stringify([...keys].sort());

export const compileSubstrateCertificationProjection = (
  input: SubstrateCertificationProjection,
): SubstrateCertificationProjection => {
  if (
    typeof input !== "object" ||
    input === null ||
    !exactKeys(input, [
      "candidateBundleIdentity",
      "manifestIdentity",
      "selectedScenarioIds",
      "scenarioResults",
      "selectionIdentity",
    ]) ||
    !sha256Identity.test(input.candidateBundleIdentity) ||
    !sha256Identity.test(input.manifestIdentity) ||
    !sha256Identity.test(input.selectionIdentity) ||
    !Array.isArray(input.selectedScenarioIds) ||
    !Array.isArray(input.scenarioResults) ||
    input.scenarioResults.length < 1 ||
    input.scenarioResults.length > 64
  )
    throw new Error("integration.certification.projection");
  const results: Readonly<{
    cleanup: "complete";
    outcome: "passed";
    scenarioId: string;
  }>[] = [];
  for (const candidateResult of input.scenarioResults as readonly unknown[]) {
    const result = candidateResult as Record<string, unknown>;
    if (
      typeof candidateResult !== "object" ||
      candidateResult === null ||
      !exactKeys(result, ["cleanup", "outcome", "scenarioId"]) ||
      result.cleanup !== "complete" ||
      result.outcome !== "passed" ||
      typeof result.scenarioId !== "string" ||
      !scenarioId.test(result.scenarioId)
    )
      throw new Error("integration.certification.projection");
    results.push(
      Object.freeze({
        cleanup: "complete",
        outcome: "passed",
        scenarioId: result.scenarioId,
      }),
    );
  }
  if (
    new Set(results.map(({ scenarioId: id }) => id)).size !== results.length ||
    JSON.stringify(results.map(({ scenarioId: id }) => id)) !==
      JSON.stringify([...results.map(({ scenarioId: id }) => id)].sort()) ||
    input.selectedScenarioIds.some(
      (selected) => typeof selected !== "string" || !scenarioId.test(selected),
    ) ||
    JSON.stringify(input.selectedScenarioIds) !==
      JSON.stringify(results.map(({ scenarioId: id }) => id))
  )
    throw new Error("integration.certification.projection");
  return Object.freeze({
    candidateBundleIdentity: input.candidateBundleIdentity,
    manifestIdentity: input.manifestIdentity,
    selectedScenarioIds: Object.freeze(
      Array.from(input.selectedScenarioIds as readonly string[]),
    ),
    scenarioResults: Object.freeze(results),
    selectionIdentity: input.selectionIdentity,
  });
};

const stableProjection = (projection: SubstrateCertificationProjection) => ({
  candidateBundleIdentity: projection.candidateBundleIdentity,
  manifestIdentity: projection.manifestIdentity,
  selectedScenarioIds: projection.selectedScenarioIds,
  scenarioResults: projection.scenarioResults,
  selectionIdentity: projection.selectionIdentity,
});

export const compileSubstrateCertificationReceipt = (input: {
  githubSha: string;
  projection: SubstrateCertificationProjection;
  replayOrdinal: 1 | 2 | 3;
}): SubstrateCertificationReceipt => {
  if (
    !revision.test(input.githubSha) ||
    ![1, 2, 3].includes(input.replayOrdinal)
  )
    throw new Error("integration.certification.receipt");
  const projection = compileSubstrateCertificationProjection(input.projection);
  const stableIdentity = `sha256:${createHash("sha256")
    .update(JSON.stringify(stableProjection(projection)))
    .digest("hex")}` as const;
  return Object.freeze({
    certificationReceiptVersion: 1,
    evidenceAuthority: "platform-certification-only",
    githubSha: input.githubSha,
    replayOrdinal: input.replayOrdinal,
    ...projection,
    stableIdentity,
  });
};

export const parseSubstrateCertificationReceipt = (
  input: unknown,
): SubstrateCertificationReceipt => {
  if (
    typeof input !== "object" ||
    input === null ||
    !exactKeys(input, [
      "candidateBundleIdentity",
      "certificationReceiptVersion",
      "evidenceAuthority",
      "githubSha",
      "manifestIdentity",
      "replayOrdinal",
      "selectedScenarioIds",
      "scenarioResults",
      "selectionIdentity",
      "stableIdentity",
    ])
  )
    throw new Error("integration.certification.receipt");
  const record = input as Record<string, unknown>;
  const receipt = compileSubstrateCertificationReceipt({
    githubSha: record.githubSha as string,
    projection: {
      candidateBundleIdentity: record.candidateBundleIdentity as string,
      manifestIdentity: record.manifestIdentity as string,
      selectedScenarioIds: record.selectedScenarioIds as readonly string[],
      scenarioResults:
        record.scenarioResults as SubstrateCertificationProjection["scenarioResults"],
      selectionIdentity: record.selectionIdentity as string,
    },
    replayOrdinal: record.replayOrdinal as 1 | 2 | 3,
  });
  if (
    record.certificationReceiptVersion !== 1 ||
    record.evidenceAuthority !== "platform-certification-only" ||
    record.stableIdentity !== receipt.stableIdentity
  )
    throw new Error("integration.certification.receipt");
  return receipt;
};

export const requireThreeMatchingCertificationReceipts = (
  inputs: readonly unknown[],
): SubstrateCertificationReceipt => {
  if (inputs.length !== 3) throw new Error("integration.certification.fan-in");
  const receipts = inputs.map(parseSubstrateCertificationReceipt);
  if (
    JSON.stringify(
      [...receipts.map(({ replayOrdinal }) => replayOrdinal)].sort(),
    ) !== JSON.stringify([1, 2, 3]) ||
    new Set(receipts.map(({ githubSha }) => githubSha)).size !== 1 ||
    new Set(receipts.map(({ stableIdentity }) => stableIdentity)).size !== 1
  )
    throw new Error("integration.certification.fan-in");
  return receipts[0]!;
};
