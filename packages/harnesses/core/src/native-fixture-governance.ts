import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { basename, dirname, parse, resolve } from "node:path";
import { types } from "node:util";

const intrinsicReflectApply = Reflect.apply;
const intrinsicIsProxy = types.isProxy;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicObjectGetOwnPropertyDescriptors =
  Object.getOwnPropertyDescriptors;

type AuthenticatedArtifactAuthority = Readonly<{
  status: "authenticated";
  digest: string;
}>;

type UnresolvedArtifactAuthority = Readonly<{
  status: "unresolved";
  reason: "independent-integrity-unavailable";
}>;

type ArtifactAuthority =
  AuthenticatedArtifactAuthority | UnresolvedArtifactAuthority;

export type HarnessNativeFixtureProvenance =
  | Readonly<{
      captureKind: "disposable-hermetic";
      sourceReference: string;
      artifactAuthority: AuthenticatedArtifactAuthority;
      captureRecipe: string;
    }>
  | Readonly<{
      captureKind: "synthetic";
      sourceReference: string;
      artifactAuthority: UnresolvedArtifactAuthority;
      captureRecipe: string;
    }>;

export type HarnessNativeFixtureReviewRecord<
  Role extends "privacy" | "redistribution",
> = Readonly<{
  role: Role;
  reviewTaskIdentity: string;
  reviewExecutionIdentity: string;
  reviewedHeadSha: string;
  reviewedFixtureBlobSha: string;
  submittedAt: string;
  reference: string;
}>;

export type HarnessNativeFixtureGovernance = Readonly<{
  provenance: HarnessNativeFixtureProvenance;
  license: Readonly<{
    reviewedLicenseId: string;
    redistribution: "reviewed-for-repository";
    sourceReference: string;
  }>;
  redaction: Readonly<{
    profileVersion: 1;
    classification: "sanitized-native-fixture";
    rawContentRetained: false;
    removedCategories: readonly [
      "credentials",
      "raw-transcript",
      "terminal-output",
      "user-content",
      "user-paths",
    ];
  }>;
  review: Readonly<{
    status: "approved";
    records: readonly [
      privacyReview: HarnessNativeFixtureReviewRecord<"privacy">,
      redistributionReview: HarnessNativeFixtureReviewRecord<"redistribution">,
    ];
  }>;
  representative: Readonly<{
    scenarioId: string;
    representativeVersion: string;
    evidenceSlot: string;
  }>;
}>;

export type HarnessSanitizedFixture = Readonly<{
  fixtureVersion: 1;
  fixtureId: string;
  harnessId: string;
  harnessVersion: string;
  governance: HarnessNativeFixtureGovernance;
  nativeIdentityKind: "run" | "session" | "thread";
  nativeIdentity: string;
  sourceGeneration: number;
  positionKind: "byte-offset" | "event-index" | "line" | "sequence";
  availableStartPosition: number;
  boundaryKind: "hook-invocation" | "session" | "transcript-range" | "turn";
  boundaryId: string;
  exclusiveEndPosition: number;
  expectedFields: readonly string[];
  sanitizedPayload: Readonly<Record<string, string | number | boolean>>;
}>;

export type NativeFixtureInventoryEntry = Readonly<{
  harnessId: string;
  fixtureId: string;
  harnessVersion: string;
  relativePath: string;
  artifactAuthority: "authenticated" | "unresolved";
  sha256: string;
}>;

export class NativeFixtureGovernanceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "NativeFixtureGovernanceError";
  }
}

const fail = (code: string): never => {
  throw new NativeFixtureGovernanceError(code);
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  code: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    fail(code);
};

const record = (
  value: unknown,
  expected: readonly string[] | undefined,
  code: string,
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    intrinsicReflectApply(intrinsicIsProxy, undefined, [value]) ||
    Array.isArray(value)
  )
    fail(code);
  const target = value as object;
  const prototype = intrinsicReflectApply(
    intrinsicObjectGetPrototypeOf,
    Object,
    [target],
  ) as object | null;
  const keys = intrinsicReflectApply(intrinsicReflectOwnKeys, Reflect, [
    target,
  ]) as readonly (string | symbol)[];
  const descriptors = intrinsicReflectApply(
    intrinsicObjectGetOwnPropertyDescriptors,
    Object,
    [target],
  ) as Readonly<
    Record<string, PropertyDescriptor> & { [key: symbol]: PropertyDescriptor }
  >;
  if (
    prototype !== Object.prototype ||
    keys.some((key) => typeof key !== "string")
  )
    fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys as readonly string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    )
      fail(code);
    const dataDescriptor = descriptor as PropertyDescriptor & {
      value: unknown;
    };
    result[key] = dataDescriptor.value;
  }
  if (expected !== undefined) exactKeys(result, expected, code);
  return result;
};

const denseArray = (
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): readonly unknown[] => {
  if (
    typeof value !== "object" ||
    value === null ||
    intrinsicReflectApply(intrinsicIsProxy, undefined, [value])
  )
    fail(code);
  const array = Array.isArray(value) ? value : fail(code);
  const prototype = intrinsicReflectApply(
    intrinsicObjectGetPrototypeOf,
    Object,
    [array],
  ) as object | null;
  const keys = intrinsicReflectApply(intrinsicReflectOwnKeys, Reflect, [
    array,
  ]) as readonly (string | symbol)[];
  const descriptors = intrinsicReflectApply(
    intrinsicObjectGetOwnPropertyDescriptors,
    Object,
    [array],
  ) as unknown as Readonly<
    Record<string, PropertyDescriptor> & {
      [key: symbol]: PropertyDescriptor;
    }
  >;
  const lengthValue: unknown = (
    descriptors.length as PropertyDescriptor & { value: unknown }
  ).value;
  if (
    prototype !== Array.prototype ||
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < minimum ||
    lengthValue > maximum ||
    keys.length !== lengthValue + 1 ||
    keys.some((key) => typeof key === "symbol")
  )
    fail(code);
  const length = lengthValue as number;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    )
      fail(code);
    output.push((descriptor as PropertyDescriptor & { value: unknown }).value);
  }
  return Object.freeze(output);
};

const idPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const fieldPattern = /^[a-z][a-z0-9_.-]{0,95}$/u;
const safeTokenPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const digestPattern = /^sha256-[a-f0-9]{64}$/u;
const isoDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const submittedTimestampPattern =
  /^(?<date>\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const syntheticReferencePattern =
  /^urn:agentscope:synthetic:[a-z0-9][a-z0-9._:-]{0,127}$/u;
const forbiddenPayloadKey =
  /(?:^|[_.-])(?:api[_-]?key|auth(?:orization)?|cookie|credential|message|password|prompt|raw|secret|stderr|stdout|terminal|transcript)(?:$|[_.-])/iu;
const forbiddenText =
  /(?:bearer\s|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret|sk-[a-z0-9]|ghp_[a-z0-9]|AKIA[0-9A-Z]|-----BEGIN|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.|file:\/\/|(?:^|\s)~[\\/]|(?:^|\s)\/(?:Users|home|private|root|tmp|Volumes)\/|[A-Za-z]:\\)/iu;
const baselineSecretPatterns = Object.freeze(
  [
    "\\b(?:api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\\s*[:=]\\s*\\S+",
    "(?:^|[^A-Za-z\\d_-])(?:[A-Za-z][A-Za-z\\d_-]*)?(?:api[_-]?key|auth[_-]?token|session[_-]?token|github[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|password|token|secret|credential)\\s*[:=]\\s*\\S+",
    "\\bBearer\\s+\\S+",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bsk-[A-Za-z\\d_-]{12,}\\b",
    "\\beyJ[A-Za-z\\d_-]{8,}\\.[A-Za-z\\d_-]{8,}\\.[A-Za-z\\d_-]{8,}\\b",
    "-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----",
    "\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis):\\/\\/[^\\s/@:]+:[^\\s/@]+@",
    "\\b(?:[A-Z][A-Z\\d]*_)*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SECRET_ACCESS_KEY)\\s*=\\s*\\S+",
    "\\bgh[pousr]_[A-Za-z\\d]{20,}\\b",
    "\\bgithub_pat_[A-Za-z\\d_]{20,}\\b",
    "\\bglpat-[A-Za-z\\d_-]{20,}\\b",
    "\\bxox[baprs]-[A-Za-z\\d-]{10,}\\b",
    "\\bnpm_[A-Za-z\\d]{20,}\\b",
    "\\bsk_live_[A-Za-z\\d]{16,}\\b",
    "\\bAIza[A-Za-z\\d_-]{20,}\\b",
    "\\bhf_[A-Za-z\\d]{20,}\\b",
  ].map((source) => new RegExp(source, "iu")),
);
const contentIsForbidden = (value: string): boolean =>
  forbiddenText.test(value) ||
  baselineSecretPatterns.some((pattern) => pattern.test(value));
const baselineContentIsForbidden = (value: string): boolean =>
  baselineSecretPatterns.some((pattern) => pattern.test(value));
const decodedContentFails = (
  value: string,
  predicate: (candidate: string) => boolean,
): boolean => {
  let current = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    if (predicate(current)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    current = decoded;
  }
  /* v8 ignore next -- each successful percent-decoding pass strictly shortens
   * current, so it reaches stability or a decoding error within value.length. */
  return true;
};
const decodedContentIsForbidden = (value: string): boolean =>
  decodedContentFails(value, contentIsForbidden);
const removedCategories = Object.freeze([
  "credentials",
  "raw-transcript",
  "terminal-output",
  "user-content",
  "user-paths",
] as const);

const string = (value: unknown, pattern: RegExp, code: string): string => {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    baselineContentIsForbidden(value)
  )
    fail(code);
  return value as string;
};

const reviewedLicenseIdPattern =
  /^(?:(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]{0,63}|LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,63})$/u;
const agentscopeSyntheticLicenseId = "LicenseRef-Agentscope-Synthetic";
const agentscopeSyntheticLicenseSourcePattern =
  /^https:\/\/github\.com\/Melbourneandrew\/agentscope\/blob\/(?!0{40}\/)[a-f0-9]{40}\/packages\/harnesses\/core\/NATIVE_FIXTURES\.md#licenseref-agentscope-synthetic$/u;
const concreteFixtureReviewPattern =
  /^https:\/\/github\.com\/Melbourneandrew\/agentscope\/pull\/(?<pullRequest>[1-9]\d{0,9})#(?:(?:pullrequestreview|issuecomment)-[1-9]\d{0,19})$/u;
const gitObjectShaPattern = /^(?!0{40}$)[a-f0-9]{40}$/u;
const reviewTaskIdentityPattern =
  /^\/root(?:\/[a-z0-9][a-z0-9_-]{0,63}){1,6}$/u;
const reviewExecutionIdentityPattern =
  /^01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

const calendarDate = (value: unknown): string => {
  const candidate = string(
    value,
    isoDatePattern,
    "harness.fixture.review.date",
  );
  const [yearText, monthText, dayText] = candidate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (year < 1 || daysInMonth === undefined || day > daysInMonth)
    fail("harness.fixture.review.date");
  return candidate;
};

const submittedTimestamp = (value: unknown): string => {
  const candidate = string(
    value,
    submittedTimestampPattern,
    "harness.fixture.review.records",
  );
  const date = submittedTimestampPattern.exec(candidate)?.groups?.date;
  try {
    calendarDate(date);
  } catch {
    fail("harness.fixture.review.records");
  }
  return candidate;
};

const normalizedDecodedUrlPath = (value: string): string => {
  let current = value;
  for (let depth = 0; depth <= value.length; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      /* v8 ignore next -- boundedSourceReference rejects undecodable input
       * before this defense-in-depth alias classifier is called. */
      return current;
    }
    if (decoded === current) break;
    current = decoded;
  }
  const segments: string[] = [];
  for (const segment of current.toLowerCase().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

const isAgentscopeGovernanceDocumentReference = (value: string): boolean => {
  const parsed = (() => {
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) return false;
  const path = normalizedDecodedUrlPath(parsed.pathname);
  return path.endsWith("/packages/harnesses/core/native_fixtures.md");
};

const positiveSafeInteger = (value: unknown, code: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(code);
  return value as number;
};

const oneOf = <const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  code: string,
): Values[number] => {
  if (typeof value !== "string" || !values.includes(value)) fail(code);
  return value as Values[number];
};

const boundedSourceReference = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    baselineContentIsForbidden(value)
  )
    fail("harness.fixture.provenance.source-reference");
  const reference = value as string;
  if (decodedContentFails(reference, baselineContentIsForbidden))
    fail("harness.fixture.provenance.source-reference");
  return reference;
};

const sourceReferenceFromBounded = (
  reference: string,
  captureKind: "disposable-hermetic" | "synthetic",
): string => {
  if (captureKind === "synthetic") {
    if (!syntheticReferencePattern.test(reference))
      fail("harness.fixture.provenance.source-reference");
    return reference;
  }
  const parsed = (() => {
    try {
      return new URL(reference);
    } catch {
      return fail("harness.fixture.provenance.source-reference");
    }
  })();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    fail("harness.fixture.provenance.source-reference");
  for (const component of [
    parsed.href,
    parsed.hostname,
    parsed.pathname,
    parsed.port,
  ])
    /* v8 ignore next -- the raw reference is recursively decoded and scanned
     * above; canonical component scanning is retained as normalization defense. */
    if (decodedContentFails(component, baselineContentIsForbidden))
      fail("harness.fixture.provenance.source-reference");
  return reference;
};

const sourceReference = (
  value: unknown,
  captureKind: "disposable-hermetic" | "synthetic",
): string =>
  sourceReferenceFromBounded(boundedSourceReference(value), captureKind);

type GovernanceRecords = Readonly<{
  provenance: Readonly<Record<string, unknown>>;
  license: Readonly<Record<string, unknown>>;
  redaction: Readonly<Record<string, unknown>>;
  review: Readonly<Record<string, unknown>>;
  representative: Readonly<Record<string, unknown>>;
}>;

const governanceRecords = (value: unknown): GovernanceRecords => {
  const root = record(
    value,
    ["provenance", "license", "redaction", "review", "representative"],
    "harness.fixture.governance.shape",
  );
  return Object.freeze({
    provenance: record(
      root.provenance,
      ["captureKind", "sourceReference", "artifactAuthority", "captureRecipe"],
      "harness.fixture.provenance.shape",
    ),
    license: record(
      root.license,
      ["reviewedLicenseId", "redistribution", "sourceReference"],
      "harness.fixture.license.shape",
    ),
    redaction: record(
      root.redaction,
      [
        "profileVersion",
        "classification",
        "rawContentRetained",
        "removedCategories",
      ],
      "harness.fixture.redaction.shape",
    ),
    review: record(
      root.review,
      ["status", "records"],
      "harness.fixture.review.shape",
    ),
    representative: record(
      root.representative,
      ["scenarioId", "representativeVersion", "evidenceSlot"],
      "harness.fixture.representative.shape",
    ),
  });
};

const parseReviewRecord = <Role extends "privacy" | "redistribution">(
  value: unknown,
  expectedRole: Role,
): HarnessNativeFixtureReviewRecord<Role> => {
  const review = record(
    value,
    [
      "role",
      "reviewTaskIdentity",
      "reviewExecutionIdentity",
      "reviewedHeadSha",
      "reviewedFixtureBlobSha",
      "submittedAt",
      "reference",
    ],
    "harness.fixture.review.records",
  );
  if (review.role !== expectedRole) fail("harness.fixture.review.records");
  return Object.freeze({
    role: expectedRole,
    reviewTaskIdentity: string(
      review.reviewTaskIdentity,
      reviewTaskIdentityPattern,
      "harness.fixture.review.records",
    ),
    reviewExecutionIdentity: string(
      review.reviewExecutionIdentity,
      reviewExecutionIdentityPattern,
      "harness.fixture.review.records",
    ),
    reviewedHeadSha: string(
      review.reviewedHeadSha,
      gitObjectShaPattern,
      "harness.fixture.review.records",
    ),
    reviewedFixtureBlobSha: string(
      review.reviewedFixtureBlobSha,
      gitObjectShaPattern,
      "harness.fixture.review.records",
    ),
    submittedAt: submittedTimestamp(review.submittedAt),
    reference: string(
      review.reference,
      concreteFixtureReviewPattern,
      "harness.fixture.review.records",
    ),
  });
};

function parseArtifactAuthority(
  value: unknown,
  captureKind: "disposable-hermetic",
): AuthenticatedArtifactAuthority;
function parseArtifactAuthority(
  value: unknown,
  captureKind: "synthetic",
): UnresolvedArtifactAuthority;
function parseArtifactAuthority(
  value: unknown,
  captureKind: "disposable-hermetic" | "synthetic",
): ArtifactAuthority {
  if (captureKind === "disposable-hermetic") {
    const authenticated = record(
      value,
      ["status", "digest"],
      "harness.fixture.provenance.artifact-authority",
    );
    if (authenticated.status !== "authenticated")
      fail("harness.fixture.provenance.artifact-authority");
    return Object.freeze({
      status: "authenticated" as const,
      digest: string(
        authenticated.digest,
        digestPattern,
        "harness.fixture.provenance.artifact-digest",
      ),
    });
  }
  const unresolved = record(
    value,
    ["status", "reason"],
    "harness.fixture.provenance.artifact-authority",
  );
  if (
    unresolved.status !== "unresolved" ||
    unresolved.reason !== "independent-integrity-unavailable"
  )
    fail("harness.fixture.provenance.artifact-authority");
  return Object.freeze({
    status: "unresolved" as const,
    reason: "independent-integrity-unavailable" as const,
  });
}

const parseProvenance = (
  provenance: Readonly<Record<string, unknown>>,
): HarnessNativeFixtureProvenance => {
  const captureKind = oneOf(
    provenance.captureKind,
    ["disposable-hermetic", "synthetic"] as const,
    "harness.fixture.provenance.capture-kind",
  );
  const shared = {
    sourceReference: sourceReference(provenance.sourceReference, captureKind),
    captureRecipe: string(
      provenance.captureRecipe,
      idPattern,
      "harness.fixture.provenance.capture-recipe",
    ),
  };
  return captureKind === "disposable-hermetic"
    ? Object.freeze({
        captureKind,
        ...shared,
        artifactAuthority: parseArtifactAuthority(
          provenance.artifactAuthority,
          captureKind,
        ),
      })
    : Object.freeze({
        captureKind,
        ...shared,
        artifactAuthority: parseArtifactAuthority(
          provenance.artifactAuthority,
          captureKind,
        ),
      });
};

const parseGovernance = (value: unknown): HarnessNativeFixtureGovernance => {
  const { provenance, license, redaction, review, representative } =
    governanceRecords(value);
  if (
    license.redistribution !== "reviewed-for-repository" ||
    redaction.profileVersion !== 1 ||
    redaction.classification !== "sanitized-native-fixture" ||
    redaction.rawContentRetained !== false ||
    review.status !== "approved"
  )
    fail("harness.fixture.governance.disposition");
  if (
    denseArray(
      redaction.removedCategories,
      removedCategories.length,
      removedCategories.length,
      "harness.fixture.redaction.categories",
    ).some((category, index) => category !== removedCategories[index])
  )
    fail("harness.fixture.redaction.categories");
  const rawReviewRecords = denseArray(
    review.records,
    2,
    2,
    "harness.fixture.review.records",
  );
  const privacyReview = parseReviewRecord(rawReviewRecords[0], "privacy");
  const redistributionReview = parseReviewRecord(
    rawReviewRecords[1],
    "redistribution",
  );
  const privacyReference = concreteFixtureReviewPattern.exec(
    privacyReview.reference,
  );
  const redistributionReference = concreteFixtureReviewPattern.exec(
    redistributionReview.reference,
  );
  if (
    privacyReview.reviewTaskIdentity ===
      redistributionReview.reviewTaskIdentity ||
    privacyReview.reviewExecutionIdentity ===
      redistributionReview.reviewExecutionIdentity ||
    privacyReview.reviewedHeadSha !== redistributionReview.reviewedHeadSha ||
    privacyReview.reviewedFixtureBlobSha !==
      redistributionReview.reviewedFixtureBlobSha ||
    privacyReview.submittedAt >= redistributionReview.submittedAt ||
    privacyReview.reference === redistributionReview.reference ||
    privacyReference?.groups?.pullRequest !==
      redistributionReference?.groups?.pullRequest
  )
    fail("harness.fixture.review.records");
  const parsedProvenance = parseProvenance(provenance);
  const reviewedLicenseId = string(
    license.reviewedLicenseId,
    reviewedLicenseIdPattern,
    "harness.fixture.license.reviewed-id",
  );
  let licenseSourceReference: string;
  if (parsedProvenance.captureKind === "synthetic") {
    const candidate =
      typeof license.sourceReference === "string"
        ? license.sourceReference
        : fail("harness.fixture.license.synthetic-authority");
    if (
      reviewedLicenseId !== agentscopeSyntheticLicenseId ||
      !agentscopeSyntheticLicenseSourcePattern.test(candidate) ||
      baselineContentIsForbidden(candidate)
    )
      fail("harness.fixture.license.synthetic-authority");
    licenseSourceReference = candidate;
  } else {
    if (reviewedLicenseId === agentscopeSyntheticLicenseId)
      fail("harness.fixture.license.vendor-authority");
    const candidate = boundedSourceReference(license.sourceReference);
    if (isAgentscopeGovernanceDocumentReference(candidate))
      fail("harness.fixture.license.vendor-authority");
    licenseSourceReference = sourceReferenceFromBounded(
      candidate,
      "disposable-hermetic",
    );
  }
  return Object.freeze({
    provenance: parsedProvenance,
    license: Object.freeze({
      reviewedLicenseId,
      redistribution: "reviewed-for-repository" as const,
      sourceReference: licenseSourceReference,
    }),
    redaction: Object.freeze({
      profileVersion: 1 as const,
      classification: "sanitized-native-fixture" as const,
      rawContentRetained: false as const,
      removedCategories,
    }),
    review: Object.freeze({
      status: "approved" as const,
      records: Object.freeze([privacyReview, redistributionReview] as const),
    }),
    representative: Object.freeze({
      scenarioId: string(
        representative.scenarioId,
        idPattern,
        "harness.fixture.representative.scenario",
      ),
      representativeVersion: string(
        representative.representativeVersion,
        semverPattern,
        "harness.fixture.representative.version",
      ),
      evidenceSlot: string(
        representative.evidenceSlot,
        idPattern,
        "harness.fixture.representative.evidence-slot",
      ),
    }),
  });
};

const parsePayload = (
  value: unknown,
): Readonly<Record<string, string | number | boolean>> => {
  const input = record(value, undefined, "harness.fixture.payload.shape");
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > 64)
    fail("harness.fixture.payload.bounds");
  const parsed: Record<string, string | number | boolean> = {};
  for (const [key, member] of entries) {
    if (
      !fieldPattern.test(key) ||
      forbiddenPayloadKey.test(key) ||
      baselineContentIsForbidden(key)
    )
      fail("harness.fixture.payload.key");
    if (typeof member === "string") {
      if (!safeTokenPattern.test(member) || contentIsForbidden(member))
        fail("harness.fixture.payload.value");
      parsed[key] = member;
      continue;
    }
    if (typeof member === "number" && Number.isSafeInteger(member)) {
      parsed[key] = member;
      continue;
    }
    if (typeof member === "boolean") {
      parsed[key] = member;
      continue;
    }
    fail("harness.fixture.payload.value");
  }
  return Object.freeze(parsed);
};

export const parseHarnessSanitizedFixture = (
  value: unknown,
): HarnessSanitizedFixture => {
  const root = record(
    value,
    [
      "fixtureVersion",
      "fixtureId",
      "harnessId",
      "harnessVersion",
      "governance",
      "nativeIdentityKind",
      "nativeIdentity",
      "sourceGeneration",
      "positionKind",
      "availableStartPosition",
      "boundaryKind",
      "boundaryId",
      "exclusiveEndPosition",
      "expectedFields",
      "sanitizedPayload",
    ],
    "harness.fixture.shape",
  );
  if (root.fixtureVersion !== 1) fail("harness.fixture.version");
  const expectedFields = denseArray(
    root.expectedFields,
    1,
    64,
    "harness.fixture.expected-fields",
  ).map((field: unknown) =>
    string(field, fieldPattern, "harness.fixture.expected-fields"),
  );
  if (new Set(expectedFields).size !== expectedFields.length)
    fail("harness.fixture.expected-fields");
  const governance = parseGovernance(root.governance);
  const harnessVersion = string(
    root.harnessVersion,
    semverPattern,
    "harness.fixture.harness-version",
  );
  if (governance.representative.representativeVersion !== harnessVersion)
    fail("harness.fixture.representative.version-link");
  const nativeIdentityKind = oneOf(
    root.nativeIdentityKind,
    ["run", "session", "thread"] as const,
    "harness.fixture.native-identity-kind",
  );
  const positionKind = oneOf(
    root.positionKind,
    ["byte-offset", "event-index", "line", "sequence"] as const,
    "harness.fixture.position-kind",
  );
  const boundaryKind = oneOf(
    root.boundaryKind,
    ["hook-invocation", "session", "transcript-range", "turn"] as const,
    "harness.fixture.boundary-kind",
  );
  const start = positiveSafeInteger(
    root.availableStartPosition,
    "harness.fixture.position",
  );
  const end = positiveSafeInteger(
    root.exclusiveEndPosition,
    "harness.fixture.position",
  );
  if (end <= start) fail("harness.fixture.position-order");
  return Object.freeze({
    fixtureVersion: 1,
    fixtureId: string(root.fixtureId, idPattern, "harness.fixture.id"),
    harnessId: string(root.harnessId, idPattern, "harness.fixture.harness-id"),
    harnessVersion,
    governance,
    nativeIdentityKind,
    nativeIdentity: string(
      root.nativeIdentity,
      safeTokenPattern,
      "harness.fixture.native-identity",
    ),
    sourceGeneration: positiveSafeInteger(
      root.sourceGeneration,
      "harness.fixture.source-generation",
    ),
    positionKind,
    availableStartPosition: start,
    boundaryKind,
    boundaryId: string(
      root.boundaryId,
      safeTokenPattern,
      "harness.fixture.boundary-id",
    ),
    exclusiveEndPosition: end,
    expectedFields: Object.freeze(expectedFields),
    sanitizedPayload: parsePayload(root.sanitizedPayload),
  });
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value.map((member) => canonicalValue(member));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalValue((value as Readonly<Record<string, unknown>>)[key]),
      ]),
  );
};

export const serializeHarnessSanitizedFixture = (
  fixture: HarnessSanitizedFixture,
): string => `${JSON.stringify(canonicalValue(fixture), null, 2)}\n`;

type NativeFixtureAuditEvent =
  | "lexical-ancestry-before-capability"
  | "root-capability-acquired"
  | "root-capability-before-release";

type NativeFixtureAuditDirective =
  | "authority-expiry"
  | "malformed-terminal"
  | "missing-terminal"
  | "nonzero-exit"
  | "oversized-output"
  | "terminate-child"
  | "timeout-child"
  | undefined;

const capabilityAuthorityPhases = Object.freeze([
  "after-ready-await",
  "after-settlement-await",
  "after-snapshot-await",
  "after-terminal-await",
  "before-ready-await",
  "before-settlement-await",
  "before-snapshot-await",
  "before-terminal-await",
] as const);
type CapabilityAuthorityPhase = (typeof capabilityAuthorityPhases)[number];

const isCapabilityAuthorityPhase = (
  value: unknown,
): value is CapabilityAuthorityPhase =>
  typeof value === "string" &&
  (capabilityAuthorityPhases as readonly string[]).includes(value);

type NativeFixtureAuditTestPlanDescriptor =
  | Readonly<{
      kind: "worker-directive";
      directive: Exclude<NativeFixtureAuditDirective, undefined>;
    }>
  | Readonly<{
      kind: "expire-at-capability-phase";
      phase: CapabilityAuthorityPhase;
    }>
  | Readonly<{
      kind:
        | "expire-after-capability"
        | "expire-after-prepare"
        | "hold-root-before-capability"
        | "namespace-operation-failure"
        | "root-operation-failure-after-hold"
        | "restore-operation-failure"
        | "swap-root-before-capability"
        | "swap-root-during-scan";
    }>
  | Readonly<{ kind: "signal-before-release" }>;

type NativeFixtureAuditTestPlanRuntime = Readonly<{
  descriptor: NativeFixtureAuditTestPlanDescriptor;
  namespaceRoot?: string;
  heldRoot?: string;
  replacementRoot?: string;
  state: {
    rootHeld: boolean;
    replacementAtRoot: boolean;
  };
}>;

declare const nativeFixtureAuditTestPlanBrand: unique symbol;
export type NativeFixtureAuditTestPlan = string & {
  readonly [nativeFixtureAuditTestPlanBrand]: true;
};

const physicalTemporaryRoot = realpathSync(tmpdir());
const activeAuditWorkerPids = new Set<number>();
/* eslint-disable-next-line @typescript-eslint/unbound-method -- captured before
 * any hostile test input can mutate the public intrinsic. */
const intrinsicPromiseThen = Promise.prototype.then;
const intrinsicIsPromise = types.isPromise;
const discardPromiseRejection = (): undefined => undefined;

const assertAuditAuthority = (
  authorityDeadline: number,
  forceExpired = false,
): void => {
  if (forceExpired || performance.now() >= authorityDeadline)
    fail("harness.fixture.inventory.capability");
};

export const activeNativeFixtureAuditWorkerCountForTest = (): number =>
  activeAuditWorkerPids.size;

const drainRejectedNativePromise = (value: object): void => {
  if (
    intrinsicReflectApply(intrinsicIsProxy, undefined, [value]) ||
    !intrinsicReflectApply(intrinsicIsPromise, undefined, [value])
  )
    return;
  void intrinsicReflectApply(intrinsicPromiseThen, value, [
    undefined,
    discardPromiseRejection,
  ]);
};

const authenticateOwnedTestRoot = (value: string): void => {
  const identity = (() => {
    try {
      return lstatSync(value);
    } catch {
      /* v8 ignore next -- lexical ancestry was authenticated immediately before
       * this synchronous check; the guard retains content-free OS-race failure. */
      return fail("harness.fixture.inventory.test-plan");
    }
  })();
  if (
    value.length > 1_024 ||
    resolve(value) !== value ||
    dirname(value) !== physicalTemporaryRoot ||
    !basename(value).startsWith("agentscope-native-fixtures-") ||
    realpathSync(value) !== value ||
    !identity.isDirectory() ||
    identity.isSymbolicLink()
  )
    fail("harness.fixture.inventory.test-plan");
};

const parseAuditTestPlan = (
  value: unknown,
): NativeFixtureAuditTestPlanDescriptor | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    if (typeof value === "object" && value !== null)
      drainRejectedNativePromise(value);
    return fail("harness.fixture.inventory.test-plan");
  }
  if (Buffer.byteLength(value, "utf8") > 8_192)
    return fail("harness.fixture.inventory.test-plan");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return fail("harness.fixture.inventory.test-plan");
  }
  const snapshot = record(
    decoded,
    undefined,
    "harness.fixture.inventory.test-plan",
  );
  if (snapshot.kind === "worker-directive") {
    exactKeys(
      snapshot,
      ["kind", "directive"],
      "harness.fixture.inventory.test-plan",
    );
    switch (snapshot.directive) {
      case "authority-expiry":
      case "malformed-terminal":
      case "missing-terminal":
      case "nonzero-exit":
      case "oversized-output":
      case "terminate-child":
      case "timeout-child":
        return Object.freeze({
          kind: "worker-directive" as const,
          directive: snapshot.directive,
        });
      default:
        return fail("harness.fixture.inventory.test-plan");
    }
  }
  if (snapshot.kind === "expire-at-capability-phase") {
    exactKeys(
      snapshot,
      ["kind", "phase"],
      "harness.fixture.inventory.test-plan",
    );
    if (!isCapabilityAuthorityPhase(snapshot.phase))
      return fail("harness.fixture.inventory.test-plan");
    return Object.freeze({
      kind: "expire-at-capability-phase" as const,
      phase: snapshot.phase,
    });
  }
  if (
    snapshot.kind === "expire-after-capability" ||
    snapshot.kind === "expire-after-prepare" ||
    snapshot.kind === "hold-root-before-capability" ||
    snapshot.kind === "namespace-operation-failure" ||
    snapshot.kind === "root-operation-failure-after-hold" ||
    snapshot.kind === "restore-operation-failure" ||
    snapshot.kind === "swap-root-before-capability" ||
    snapshot.kind === "swap-root-during-scan"
  ) {
    exactKeys(snapshot, ["kind"], "harness.fixture.inventory.test-plan");
    return Object.freeze({ kind: snapshot.kind });
  }
  if (snapshot.kind === "signal-before-release") {
    exactKeys(snapshot, ["kind"], "harness.fixture.inventory.test-plan");
    return Object.freeze({ kind: "signal-before-release" as const });
  }
  return fail("harness.fixture.inventory.test-plan");
};

const prepareAuditTestPlan = (
  descriptor: NativeFixtureAuditTestPlanDescriptor | undefined,
  root: string,
): NativeFixtureAuditTestPlanRuntime | undefined => {
  if (descriptor === undefined) return undefined;
  if (
    descriptor.kind !== "expire-after-prepare" &&
    descriptor.kind !== "hold-root-before-capability" &&
    descriptor.kind !== "namespace-operation-failure" &&
    descriptor.kind !== "root-operation-failure-after-hold" &&
    descriptor.kind !== "restore-operation-failure" &&
    descriptor.kind !== "swap-root-before-capability" &&
    descriptor.kind !== "swap-root-during-scan"
  )
    return Object.freeze({
      descriptor,
      state: { rootHeld: false, replacementAtRoot: false },
    });
  authenticateOwnedTestRoot(root);
  let namespaceRoot: string | undefined;
  try {
    namespaceRoot = mkdtempSync(
      `${physicalTemporaryRoot}/agentscope-native-fixture-plan-`,
    );
    if (descriptor.kind === "namespace-operation-failure")
      throw new Error("synthetic namespace failure");
    const identity = lstatSync(namespaceRoot, { bigint: true });
    /* v8 ignore next 8 -- mkdtempSync with this physical direct-child template
     * guarantees these closed namespace invariants; they remain fail-closed. */
    if (
      dirname(namespaceRoot) !== physicalTemporaryRoot ||
      realpathSync(namespaceRoot) !== namespaceRoot ||
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      (Number(identity.mode) & 0o077) !== 0
    )
      fail("harness.fixture.inventory.test-plan");
    return Object.freeze({
      descriptor,
      namespaceRoot,
      heldRoot: `${namespaceRoot}/held`,
      replacementRoot: `${namespaceRoot}/replacement`,
      state: { rootHeld: false, replacementAtRoot: false },
    });
  } catch {
    /* v8 ignore else -- mkdtempSync failed before any owned path existed, so
     * the false branch has no cleanup behavior to exercise. */
    if (namespaceRoot !== undefined) {
      try {
        rmSync(namespaceRoot, { force: true, recursive: true });
      } catch {
        /* v8 ignore next -- the freshly created empty private namespace has no
         * independent mutation source; retain a content-free OS-fault guard. */
        return fail("harness.fixture.inventory.test-plan");
      }
    }
    return fail("harness.fixture.inventory.test-plan");
  }
};

const restoreAuditTestPlan = (
  runtime: NativeFixtureAuditTestPlanRuntime | undefined,
  root: string,
): void => {
  if (runtime?.namespaceRoot === undefined) return;
  try {
    if (runtime.state.rootHeld) {
      if (runtime.state.replacementAtRoot) {
        renameSync(root, runtime.replacementRoot!);
        runtime.state.replacementAtRoot = false;
      }
      renameSync(runtime.heldRoot!, root);
      runtime.state.rootHeld = false;
    }
    rmSync(runtime.namespaceRoot, { recursive: true });
    if (runtime.descriptor.kind === "restore-operation-failure")
      throw new Error("synthetic restore failure");
  } catch {
    fail("harness.fixture.inventory.test-plan");
  }
};

const applyAuditTestPlan = (
  runtime: NativeFixtureAuditTestPlanRuntime | undefined,
  event: NativeFixtureAuditEvent,
  root: string,
  childProcessId?: number,
): void => {
  if (runtime === undefined) return;
  const plan = runtime.descriptor;
  try {
    if (
      (plan.kind === "hold-root-before-capability" ||
        plan.kind === "root-operation-failure-after-hold" ||
        plan.kind === "swap-root-before-capability") &&
      event === "lexical-ancestry-before-capability"
    ) {
      renameSync(root, runtime.heldRoot!);
      runtime.state.rootHeld = true;
      if (plan.kind === "root-operation-failure-after-hold")
        fail("harness.fixture.inventory.test-plan");
      if (plan.kind === "swap-root-before-capability") {
        mkdirSync(root, { mode: 0o700 });
        runtime.state.replacementAtRoot = true;
      }
    } else if (
      plan.kind === "swap-root-during-scan" &&
      event === "root-capability-acquired"
    ) {
      renameSync(root, runtime.heldRoot!);
      runtime.state.rootHeld = true;
      mkdirSync(root, { mode: 0o700 });
      runtime.state.replacementAtRoot = true;
    } else if (
      plan.kind === "swap-root-during-scan" &&
      event === "root-capability-before-release"
    ) {
      renameSync(root, runtime.replacementRoot!);
      runtime.state.replacementAtRoot = false;
      renameSync(runtime.heldRoot!, root);
      runtime.state.rootHeld = false;
    } else if (
      plan.kind === "signal-before-release" &&
      event === "root-capability-before-release" &&
      childProcessId !== undefined
    ) {
      process.kill(childProcessId, "SIGKILL");
    }
  } catch {
    fail("harness.fixture.inventory.test-plan");
  }
};

type AncestorIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
}>;

const authenticateLexicalAncestry = async (
  input: string,
): Promise<readonly AncestorIdentity[]> => {
  const lexicalRoot = resolve(input);
  const filesystemRoot = parse(lexicalRoot).root;
  const paths: string[] = [filesystemRoot];
  let cursor = lexicalRoot;
  const descendants: string[] = [];
  while (cursor !== filesystemRoot) {
    descendants.push(cursor);
    cursor = dirname(cursor);
  }
  paths.push(...descendants.reverse());
  const identities: AncestorIdentity[] = [];
  for (const path of paths) {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("harness.fixture.inventory.ancestor");
    identities.push(
      Object.freeze({ path, dev: metadata.dev, ino: metadata.ino }),
    );
  }
  return Object.freeze(identities);
};

const assertStableLexicalAncestry = async (
  identities: readonly AncestorIdentity[],
): Promise<void> => {
  for (const identity of identities) {
    const metadata = await lstat(identity.path, { bigint: true }).catch(() =>
      fail("harness.fixture.inventory.ancestor-identity"),
    );
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino
    )
      fail("harness.fixture.inventory.ancestor-identity");
  }
};

const capabilityWorkerSource = String.raw`
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, statSync } from "node:fs";
const maximumFiles = 256;
const maximumDirectoryEntries = 256;
const maximumAggregateBytes = 3 * 1024 * 1024;
const maximumAggregatePathBytes = 140 * 1024;
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const compare = (left, right) => {
  const a = Array.from(left, (member) => member.codePointAt(0));
  const b = Array.from(right, (member) => member.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};
const boundedEntries = () => {
  const directory = opendirSync(".", { bufferSize: 1 });
  const entries = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= maximumDirectoryEntries) throw new Error("directory-bounds");
      entries.push(entry);
    }
  } finally { directory.closeSync(); }
  return entries.sort((left, right) => compare(left.name, right.name));
};
const root = statSync(".", { bigint: true });
process.stdout.write(JSON.stringify({ kind: "ready", dev: String(root.dev), ino: String(root.ino) }) + "\n");
process.stdin.once("data", (command) => {
  try {
    const mode = command.toString("utf8").trim();
    if (mode === "oversized-output") {
      process.stdout.write("x".repeat(5 * 1024 * 1024 + 1));
      return;
    }
    const files = [];
    let aggregateBytes = 0;
    let aggregatePathBytes = 0;
    const enter = (name) => {
      const parent = statSync(".", { bigint: true });
      const before = lstatSync(name, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("entry-kind");
      process.chdir(name);
      if (!same(before, statSync(".", { bigint: true }))) throw new Error("directory-identity");
      return parent;
    };
    const leave = (parent) => {
      process.chdir("..");
      if (!same(parent, statSync(".", { bigint: true }))) throw new Error("directory-parent");
    };
    const optional = (name) => {
      try { return lstatSync(name, { bigint: true }); }
      catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
    };
    const harnesses = boundedEntries();
    for (const harness of harnesses) {
      if (harness.name === "core") continue;
      if (!harness.isDirectory() || harness.isSymbolicLink()) throw new Error("entry-kind");
      const rootParent = enter(harness.name);
      const fixtures = optional("fixtures");
      if (fixtures === undefined) { leave(rootParent); continue; }
      const harnessParent = enter("fixtures");
      const native = optional("native");
      if (native === undefined) { leave(harnessParent); leave(rootParent); continue; }
      const fixturesParent = enter("native");
      const entries = boundedEntries();
      for (const entry of entries) {
        const before = lstatSync(entry.name, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || !entry.name.endsWith(".json") || before.size > 65536n) throw new Error("file");
        const descriptor = openSync(entry.name, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(descriptor, { bigint: true });
          if (!opened.isFile() || !same(before, opened)) throw new Error("file-identity");
          const bytes = readFileSync(descriptor);
          const after = fstatSync(descriptor, { bigint: true });
          if (bytes.length > 65536 || BigInt(bytes.length) !== opened.size || !same(opened, after)) throw new Error("file");
          aggregateBytes += bytes.length;
          const relativePath = [harness.name, "fixtures", "native", entry.name].join("/");
          aggregatePathBytes += Buffer.byteLength(relativePath, "utf8");
          if (files.length >= maximumFiles || aggregateBytes > maximumAggregateBytes || aggregatePathBytes > maximumAggregatePathBytes) throw new Error("inventory-bounds");
          files.push({ relativePath, bytes: bytes.toString("base64") });
        } finally { closeSync(descriptor); }
      }
      leave(fixturesParent);
      leave(harnessParent);
      leave(rootParent);
    }
    process.stdout.write(JSON.stringify({ kind: "snapshot", files }) + "\n");
    process.stdin.once("data", () => {
      if (mode !== "missing-terminal") {
        const status = mode === "malformed-terminal" ? "incomplete" : "complete";
        process.stdout.write(JSON.stringify({ kind: "terminal", status }) + "\n");
      }
      if (mode === "nonzero-exit") process.exitCode = 2;
    });
  } catch {
    process.stdout.write(JSON.stringify({ kind: "error", code: "capability-scan" }) + "\n");
  }
});
`;

type CapabilitySnapshotFile = Readonly<{
  relativePath: string;
  bytes: Buffer;
}>;

const codePointCompare = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (member) => member.codePointAt(0)!);
  const rightPoints = Array.from(right, (member) => member.codePointAt(0)!);
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  /* v8 ignore next -- audited relative paths are unique, so sorting never
   * compares equal strings or reaches a strict-prefix terminal segment. */
  return leftPoints.length - rightPoints.length;
};

const parseCapabilityLine = (value: unknown): unknown => {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return fail("harness.fixture.inventory.capability");
};

const decodeCapabilityFiles = (
  value: unknown,
): readonly CapabilitySnapshotFile[] => {
  const files = denseArray(
    value,
    0,
    256,
    "harness.fixture.inventory.capability",
  );
  let aggregateBytes = 0;
  let aggregatePathBytes = 0;
  return Object.freeze(
    files.map((member) => {
      const file = record(
        member,
        ["relativePath", "bytes"],
        "harness.fixture.inventory.capability",
      );
      /* v8 ignore next -- the fixed worker emits string fields; the parent
       * retains this independent compromised-worker type boundary. */
      const relativePath =
        typeof file.relativePath === "string"
          ? file.relativePath
          : fail("harness.fixture.inventory.capability");
      /* v8 ignore next -- the fixed worker emits string fields; the parent
       * retains this independent compromised-worker type boundary. */
      const encodedBytes =
        typeof file.bytes === "string"
          ? file.bytes
          : fail("harness.fixture.inventory.capability");
      /* v8 ignore next -- the fixed worker emits canonical base64; the parent
       * retains this independent compromised-worker syntax boundary. */
      if (
        !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
          encodedBytes,
        )
      )
        fail("harness.fixture.inventory.capability");
      const bytes = Buffer.from(encodedBytes, "base64");
      aggregateBytes += bytes.length;
      aggregatePathBytes += Buffer.byteLength(relativePath, "utf8");
      /* v8 ignore next -- worker-side bounds make this unreachable in the
       * fixed protocol; the parent repeats them as a trust boundary. */
      if (
        bytes.length > 65_536 ||
        aggregateBytes > 3 * 1024 * 1024 ||
        aggregatePathBytes > 140 * 1024 ||
        bytes.toString("base64") !== encodedBytes
      )
        fail("harness.fixture.inventory.capability");
      return Object.freeze({ relativePath, bytes });
    }),
  );
};

type CapabilitySettlement = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

const dispatchCapabilityDirective = (
  directive: NativeFixtureAuditDirective,
  write: (command: string) => void,
  terminate: () => void,
  abort: () => void,
): boolean => {
  switch (directive) {
    case "terminate-child":
      terminate();
      return false;
    case "timeout-child":
      abort();
      return false;
    case "authority-expiry":
      write("scan\n");
      return true;
    case "malformed-terminal":
    case "missing-terminal":
    case "nonzero-exit":
    case "oversized-output":
      write(`${directive}\n`);
      return false;
    default:
      write("scan\n");
      return false;
  }
};

const settleCapabilityWorker = async (
  settlement: Promise<CapabilitySettlement>,
  authorityDeadline: number,
  forceAuthorityExpiry: boolean,
  terminate: () => void,
  childError: () => Error | undefined,
): Promise<CapabilitySettlement> => {
  const remaining = Math.max(0, authorityDeadline - performance.now());
  const authorityFailure = new Error("capability-authority-deadline");
  let resolveDeadline!: (error: Error) => void;
  const deadline = new Promise<Error>((resolve) => {
    resolveDeadline = resolve;
  });
  const expireAuthority = (): void => {
    resolveDeadline(authorityFailure);
  };
  const deadlineTimer = setTimeout(expireAuthority, remaining);
  if (forceAuthorityExpiry) expireAuthority();
  const first = await Promise.race([settlement, deadline]);
  clearTimeout(deadlineTimer);
  if (first instanceof Error) {
    terminate();
    await settlement;
    return fail("harness.fixture.inventory.capability");
  }
  if (childError() !== undefined || first.code !== 0 || first.signal !== null)
    fail("harness.fixture.inventory.capability");
  return first;
};

const spawnCapabilityWorker = (root: string, signal: AbortSignal) =>
  spawn(
    process.execPath,
    ["--input-type=module", "--eval", capabilityWorkerSource],
    {
      cwd: root,
      env: Object.freeze({}),
      signal,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

const assertCapabilityAuthority = (
  authorityDeadline: number,
  testPlan: NativeFixtureAuditTestPlanRuntime | undefined,
  phase?: CapabilityAuthorityPhase,
): void => {
  assertAuditAuthority(
    authorityDeadline,
    phase !== undefined &&
      testPlan?.descriptor.kind === "expire-at-capability-phase" &&
      testPlan.descriptor.phase === phase,
  );
};

const readCapabilityReady = async (
  lines: AsyncIterator<string>,
  expectedRoot: AncestorIdentity,
  authorityDeadline: number,
  testPlan: NativeFixtureAuditTestPlanRuntime | undefined,
): Promise<void> => {
  assertCapabilityAuthority(authorityDeadline, testPlan, "before-ready-await");
  const readyLine = await lines.next();
  assertCapabilityAuthority(authorityDeadline, testPlan, "after-ready-await");
  const ready = record(
    parseCapabilityLine(readyLine.value),
    ["kind", "dev", "ino"],
    "harness.fixture.inventory.capability",
  );
  assertCapabilityAuthority(authorityDeadline, testPlan);
  /* v8 ignore next -- the fixed child's ready record is inode-bound; this
   * rejects an external runtime/protocol violation independently. */
  if (
    readyLine.done ||
    ready.kind !== "ready" ||
    ready.dev !== String(expectedRoot.dev) ||
    ready.ino !== String(expectedRoot.ino)
  )
    fail("harness.fixture.inventory.ancestor-identity");
};

const readCapabilitySnapshot = async (
  lines: AsyncIterator<string>,
  authorityDeadline: number,
  testPlan: NativeFixtureAuditTestPlanRuntime | undefined,
): Promise<readonly CapabilitySnapshotFile[]> => {
  assertCapabilityAuthority(
    authorityDeadline,
    testPlan,
    "before-snapshot-await",
  );
  const snapshotLine = await lines.next();
  assertCapabilityAuthority(
    authorityDeadline,
    testPlan,
    "after-snapshot-await",
  );
  const parsedSnapshot = parseCapabilityLine(snapshotLine.value);
  assertCapabilityAuthority(authorityDeadline, testPlan);
  /* v8 ignore next -- the fixed worker emits only object records; the false
   * arm retains a content-free failure for compromised output. */
  const snapshotKind: unknown =
    typeof parsedSnapshot === "object" && parsedSnapshot !== null
      ? Object.getOwnPropertyDescriptor(parsedSnapshot, "kind")?.value
      : undefined;
  const snapshot = record(
    parsedSnapshot,
    snapshotKind === "snapshot" ? ["kind", "files"] : ["kind", "code"],
    "harness.fixture.inventory.capability",
  );
  assertCapabilityAuthority(authorityDeadline, testPlan);
  if (snapshotLine.done || snapshot.kind !== "snapshot")
    fail("harness.fixture.inventory.capability");
  const decodedFiles = decodeCapabilityFiles(snapshot.files);
  assertCapabilityAuthority(authorityDeadline, testPlan);
  return decodedFiles;
};

const readCapabilityTerminal = async (
  lines: AsyncIterator<string>,
  authorityDeadline: number,
  testPlan: NativeFixtureAuditTestPlanRuntime | undefined,
): Promise<void> => {
  assertCapabilityAuthority(
    authorityDeadline,
    testPlan,
    "before-terminal-await",
  );
  const terminalLine = await lines.next();
  assertCapabilityAuthority(
    authorityDeadline,
    testPlan,
    "after-terminal-await",
  );
  const terminal = record(
    parseCapabilityLine(terminalLine.value),
    ["kind", "status"],
    "harness.fixture.inventory.capability",
  );
  assertCapabilityAuthority(authorityDeadline, testPlan);
  if (
    terminalLine.done ||
    terminal.kind !== "terminal" ||
    terminal.status !== "complete"
  )
    fail("harness.fixture.inventory.capability");
};

const acquireCapabilitySnapshot = async (
  root: string,
  expectedRoot: AncestorIdentity,
  authorityDeadline: number,
  testPlan?: NativeFixtureAuditTestPlanRuntime,
): Promise<readonly CapabilitySnapshotFile[]> => {
  assertAuditAuthority(authorityDeadline);
  const controller = new AbortController();
  const abortWork = (): void => {
    controller.abort();
  };
  let workTimeout: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof spawnCapabilityWorker> | undefined;
  let settlement: Promise<CapabilitySettlement> | undefined;
  let settled: CapabilitySettlement | undefined;
  let childError: Error | undefined;
  try {
    const remainingWork = authorityDeadline - performance.now() - 1_000;
    if (remainingWork <= 0) fail("harness.fixture.inventory.capability");
    const spawnedChild = spawnCapabilityWorker(root, controller.signal);
    child = spawnedChild;
    settlement = new Promise<CapabilitySettlement>((resolveSettlement) => {
      spawnedChild.once("error", (error) => {
        childError = error;
      });
      spawnedChild.once("close", (code, signal) => {
        resolveSettlement(Object.freeze({ code, signal }));
      });
    });
    const absoluteRemainingWork = authorityDeadline - performance.now() - 1_000;
    if (absoluteRemainingWork <= 0) abortWork();
    else workTimeout = setTimeout(abortWork, absoluteRemainingWork);
    return await acquireSpawnedCapabilitySnapshot(
      Object.freeze({
        child: spawnedChild,
        root,
        expectedRoot,
        authorityDeadline,
        testPlan,
        abortWork,
        settlement,
        childError: () => childError,
        recordSettlement: (value: CapabilitySettlement) => {
          settled = value;
        },
      }),
    );
  } finally {
    if (workTimeout !== undefined) clearTimeout(workTimeout);
    if (child !== undefined && settlement !== undefined) {
      if (
        settled === undefined &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL");
      if (settled === undefined) await settlement;
      /* v8 ignore next -- the same successfully spawned child retains its pid. */
      if (child.pid !== undefined) activeAuditWorkerPids.delete(child.pid);
    }
  }
};

type SpawnedCapabilityContext = Readonly<{
  child: ReturnType<typeof spawnCapabilityWorker>;
  root: string;
  expectedRoot: AncestorIdentity;
  authorityDeadline: number;
  testPlan: NativeFixtureAuditTestPlanRuntime | undefined;
  abortWork: () => void;
  settlement: Promise<CapabilitySettlement>;
  childError: () => Error | undefined;
  recordSettlement: (settlement: CapabilitySettlement) => void;
}>;

const acquireSpawnedCapabilitySnapshot = async (
  context: SpawnedCapabilityContext,
): Promise<readonly CapabilitySnapshotFile[]> => {
  const {
    child,
    root,
    expectedRoot,
    authorityDeadline,
    testPlan,
    abortWork,
    settlement,
    childError,
    recordSettlement,
  } = context;
  const applyPlan = (event: NativeFixtureAuditEvent): void => {
    applyAuditTestPlan(testPlan, event, root, child.pid);
  };
  /* v8 ignore next -- a successfully spawned Node child always exposes pid. */
  if (child.pid !== undefined) activeAuditWorkerPids.add(child.pid);
  let outputBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 5 * 1024 * 1024) abortWork();
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  try {
    await readCapabilityReady(lines, expectedRoot, authorityDeadline, testPlan);
    assertCapabilityAuthority(authorityDeadline, testPlan);
    applyPlan("root-capability-acquired");
    assertCapabilityAuthority(authorityDeadline, testPlan);
    const directive =
      testPlan?.descriptor.kind === "worker-directive"
        ? testPlan.descriptor.directive
        : undefined;
    assertCapabilityAuthority(authorityDeadline, testPlan);
    const forceAuthorityExpiry = dispatchCapabilityDirective(
      directive,
      (command) => {
        child.stdin.write(command);
      },
      () => {
        child.kill("SIGKILL");
      },
      abortWork,
    );
    assertCapabilityAuthority(authorityDeadline, testPlan);
    const decodedFiles = await readCapabilitySnapshot(
      lines,
      authorityDeadline,
      testPlan,
    );
    assertCapabilityAuthority(authorityDeadline, testPlan);
    applyPlan("root-capability-before-release");
    assertCapabilityAuthority(authorityDeadline, testPlan);
    child.stdin.end("release\n");
    assertCapabilityAuthority(authorityDeadline, testPlan);
    await readCapabilityTerminal(lines, authorityDeadline, testPlan);
    assertCapabilityAuthority(
      authorityDeadline,
      testPlan,
      "before-settlement-await",
    );
    const settled = await settleCapabilityWorker(
      settlement,
      authorityDeadline,
      forceAuthorityExpiry,
      () => {
        child.kill("SIGKILL");
      },
      childError,
    );
    assertCapabilityAuthority(
      authorityDeadline,
      testPlan,
      "after-settlement-await",
    );
    recordSettlement(settled);
    return Object.freeze(decodedFiles);
  } catch (error) {
    if (error instanceof NativeFixtureGovernanceError) throw error;
    return fail("harness.fixture.inventory.capability");
  }
};

export const auditNativeFixtureInventory = async (
  harnessPackagesRoot: string,
  testPlanInput?: NativeFixtureAuditTestPlan,
): Promise<readonly NativeFixtureInventoryEntry[]> => {
  const authorityDeadline = performance.now() + 10_000;
  assertAuditAuthority(authorityDeadline);
  const lexicalRoot = resolve(harnessPackagesRoot);
  assertAuditAuthority(authorityDeadline);
  const testPlanDescriptor = parseAuditTestPlan(testPlanInput);
  assertAuditAuthority(authorityDeadline);
  const ancestry = await authenticateLexicalAncestry(lexicalRoot);
  assertAuditAuthority(authorityDeadline);
  const testPlan = prepareAuditTestPlan(testPlanDescriptor, lexicalRoot);
  let files: readonly CapabilitySnapshotFile[];
  try {
    assertAuditAuthority(
      authorityDeadline,
      testPlanDescriptor?.kind === "expire-after-prepare",
    );
    applyAuditTestPlan(
      testPlan,
      "lexical-ancestry-before-capability",
      lexicalRoot,
    );
    assertAuditAuthority(authorityDeadline);
    await assertStableLexicalAncestry(ancestry);
    assertAuditAuthority(authorityDeadline);
    const expectedRoot = ancestry.at(-1)!;
    assertAuditAuthority(authorityDeadline);
    files = await acquireCapabilitySnapshot(
      lexicalRoot,
      expectedRoot,
      authorityDeadline,
      testPlan,
    );
    assertAuditAuthority(authorityDeadline);
    await assertStableLexicalAncestry(ancestry);
    assertAuditAuthority(authorityDeadline);
  } finally {
    restoreAuditTestPlan(testPlan, lexicalRoot);
  }
  assertAuditAuthority(
    authorityDeadline,
    testPlanDescriptor?.kind === "expire-after-capability",
  );
  const entries: NativeFixtureInventoryEntry[] = [];
  for (const file of files) {
    assertAuditAuthority(authorityDeadline);
    const pathSegments = file.relativePath.split("/");
    /* v8 ignore next -- the fixed worker constructs this four-segment path;
     * parent validation remains as a compromised-worker boundary. */
    if (
      pathSegments.length !== 4 ||
      pathSegments[1] !== "fixtures" ||
      pathSegments[2] !== "native" ||
      !pathSegments[3]!.endsWith(".json")
    )
      fail("harness.fixture.inventory.entry-kind");
    const [harnessId, , , fileName] = pathSegments as [
      string,
      string,
      string,
      string,
    ];
    assertAuditAuthority(authorityDeadline);
    const text = file.bytes.toString("utf8");
    assertAuditAuthority(authorityDeadline);
    if (
      text.includes("\uFFFD") ||
      contentIsForbidden(text) ||
      decodedContentIsForbidden(text)
    )
      fail("harness.fixture.inventory.content");
    assertAuditAuthority(authorityDeadline);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      fail("harness.fixture.inventory.json");
    }
    assertAuditAuthority(authorityDeadline);
    const fixture = parseHarnessSanitizedFixture(input);
    assertAuditAuthority(authorityDeadline);
    if (
      fixture.harnessId !== harnessId ||
      basename(fileName, ".json") !== fixture.fixtureId
    )
      fail("harness.fixture.inventory.path-link");
    assertAuditAuthority(authorityDeadline);
    const canonicalFixture = serializeHarnessSanitizedFixture(fixture);
    assertAuditAuthority(authorityDeadline);
    if (canonicalFixture !== text)
      fail("harness.fixture.inventory.canonical-json");
    assertAuditAuthority(authorityDeadline);
    const fixtureDigest = `sha256-${createHash("sha256").update(file.bytes).digest("hex")}`;
    assertAuditAuthority(authorityDeadline);
    entries.push(
      Object.freeze({
        harnessId: fixture.harnessId,
        fixtureId: fixture.fixtureId,
        harnessVersion: fixture.harnessVersion,
        relativePath: file.relativePath,
        artifactAuthority:
          fixture.governance.provenance.artifactAuthority.status,
        sha256: fixtureDigest,
      }),
    );
    assertAuditAuthority(authorityDeadline);
  }
  assertAuditAuthority(authorityDeadline);
  entries.sort((left, right) =>
    codePointCompare(left.relativePath, right.relativePath),
  );
  assertAuditAuthority(authorityDeadline);
  const inventory = Object.freeze(entries);
  assertAuditAuthority(authorityDeadline);
  return inventory;
};
