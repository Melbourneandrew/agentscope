import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

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
    reviewedAt: string;
    references: readonly [string, string, ...string[]];
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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  const target = value as object;
  let prototype: object | null = null;
  let keys: readonly (string | symbol)[] = [];
  let descriptors: Readonly<
    Record<string, PropertyDescriptor> & { [key: symbol]: PropertyDescriptor }
  > = {};
  try {
    prototype = Object.getPrototypeOf(target) as object | null;
    keys = Reflect.ownKeys(target);
    descriptors = Object.getOwnPropertyDescriptors(target);
  } catch {
    fail(code);
  }
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
  const array = Array.isArray(value) ? value : fail(code);
  let prototype: object | null = null;
  let keys: readonly (string | symbol)[] = [];
  let descriptors: Readonly<
    Record<string, PropertyDescriptor> & { [key: symbol]: PropertyDescriptor }
  > = {};
  try {
    prototype = Object.getPrototypeOf(array) as object | null;
    keys = Reflect.ownKeys(array);
    descriptors = Object.getOwnPropertyDescriptors(
      array,
    ) as unknown as Readonly<
      Record<string, PropertyDescriptor> & {
        [key: symbol]: PropertyDescriptor;
      }
    >;
  } catch {
    fail(code);
  }
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
const reviewReferencePattern = /^[a-z][a-z0-9._:/#-]{2,127}$/u;
const isoDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
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
  /^(?:[A-Za-z0-9][A-Za-z0-9.+-]{0,63}|LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,63})$/u;

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

const sourceReference = (
  value: unknown,
  captureKind: "disposable-hermetic" | "synthetic",
): string => {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    baselineContentIsForbidden(value)
  )
    fail("harness.fixture.provenance.source-reference");
  const reference = value as string;
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
  return reference;
};

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
      ["status", "reviewedAt", "references"],
      "harness.fixture.review.shape",
    ),
    representative: record(
      root.representative,
      ["scenarioId", "representativeVersion", "evidenceSlot"],
      "harness.fixture.representative.shape",
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
  const references = denseArray(
    review.references,
    2,
    16,
    "harness.fixture.review.references",
  );
  if (
    references.some(
      (reference) =>
        typeof reference !== "string" ||
        !reviewReferencePattern.test(reference) ||
        baselineContentIsForbidden(reference),
    ) ||
    new Set(references).size !== references.length
  )
    fail("harness.fixture.review.references");
  const reviewedReferences = references as [string, string, ...string[]];
  return Object.freeze({
    provenance: parseProvenance(provenance),
    license: Object.freeze({
      reviewedLicenseId: string(
        license.reviewedLicenseId,
        reviewedLicenseIdPattern,
        "harness.fixture.license.reviewed-id",
      ),
      redistribution: "reviewed-for-repository" as const,
      sourceReference: sourceReference(
        license.sourceReference,
        "disposable-hermetic",
      ),
    }),
    redaction: Object.freeze({
      profileVersion: 1 as const,
      classification: "sanitized-native-fixture" as const,
      rawContentRetained: false as const,
      removedCategories,
    }),
    review: Object.freeze({
      status: "approved" as const,
      reviewedAt: string(
        review.reviewedAt,
        isoDatePattern,
        "harness.fixture.review.date",
      ),
      references: Object.freeze([...reviewedReferences] as [
        string,
        string,
        ...string[],
      ]),
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

type FilesystemIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

export type NativeFixtureAuditEvent =
  | "ancestry-after-resolution"
  | "ancestry-before-recheck"
  | "directory-before-authentication"
  | "directory-before-recheck"
  | "file-after-path-authentication"
  | "file-after-open-authentication"
  | "file-before-path-recheck";

export type NativeFixtureAuditObserver = (
  event: NativeFixtureAuditEvent,
  path: string,
) => Promise<void>;

const filesystemIdentity = (value: FilesystemIdentity): FilesystemIdentity =>
  Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  });

const sameFilesystemIdentity = (
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

type AncestorIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
}>;

const stableExistingAncestry = async (
  input: string,
): Promise<readonly AncestorIdentity[]> => {
  const physicalRoot = resolve(input);
  const filesystemRoot = parse(physicalRoot).root;
  const paths: string[] = [filesystemRoot];
  let cursor = physicalRoot;
  const descendants: string[] = [];
  while (cursor !== filesystemRoot) {
    descendants.push(cursor);
    cursor = dirname(cursor);
  }
  paths.push(...descendants.reverse());
  const identities: AncestorIdentity[] = [];
  for (const path of paths) {
    const metadata = await lstat(path, { bigint: true }).catch(() =>
      fail("harness.fixture.inventory.ancestor"),
    );
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("harness.fixture.inventory.ancestor");
    identities.push(
      Object.freeze({ path, dev: metadata.dev, ino: metadata.ino }),
    );
  }
  return Object.freeze(identities);
};

const rejectNestedSymlinkAncestry = async (input: string): Promise<void> => {
  const lexicalRoot = resolve(input);
  const filesystemRoot = parse(lexicalRoot).root;
  let cursor = lexicalRoot;
  while (cursor !== filesystemRoot) {
    const metadata = await lstat(cursor, { bigint: true });
    if (metadata.isSymbolicLink()) fail("harness.fixture.inventory.ancestor");
    cursor = dirname(cursor);
  }
};

const assertStableExistingAncestry = async (
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

const withStableDirectory = async <Value>(
  path: string,
  optional: boolean,
  operation: () => Promise<Value>,
  observer?: NativeFixtureAuditObserver,
): Promise<Value | undefined> => {
  let before;
  try {
    await observer?.("directory-before-authentication", path);
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink())
    fail("harness.fixture.inventory.ancestor");
  const identity = filesystemIdentity(before);
  const result = await operation();
  await observer?.("directory-before-recheck", path);
  const after = await lstat(path, { bigint: true }).catch(() =>
    fail("harness.fixture.inventory.ancestor-identity"),
  );
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFilesystemIdentity(identity, filesystemIdentity(after))
  )
    fail("harness.fixture.inventory.ancestor-identity");
  return result;
};

const readStableFixtureFile = async (
  path: string,
  observer?: NativeFixtureAuditObserver,
): Promise<Buffer> => {
  const pathIdentity = await lstat(path, { bigint: true });
  if (
    !pathIdentity.isFile() ||
    pathIdentity.isSymbolicLink() ||
    pathIdentity.size > 65_536n
  )
    fail("harness.fixture.inventory.file");
  await observer?.("file-after-path-authentication", path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => fail("harness.fixture.inventory.file"));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !sameFilesystemIdentity(
        filesystemIdentity(pathIdentity),
        filesystemIdentity(before),
      )
    )
      fail("harness.fixture.inventory.file-identity");
    await observer?.("file-after-open-authentication", path);
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536 || BigInt(bytesRead) !== before.size)
      fail("harness.fixture.inventory.file");
    const after = await handle.stat({ bigint: true });
    await observer?.("file-before-path-recheck", path);
    const finalPath = await lstat(path, { bigint: true });
    if (
      !sameFilesystemIdentity(
        filesystemIdentity(before),
        filesystemIdentity(after),
      ) ||
      !sameFilesystemIdentity(
        filesystemIdentity(before),
        filesystemIdentity(finalPath),
      )
    )
      fail("harness.fixture.inventory.file-identity");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const auditNativeFixtureInventory = async (
  harnessPackagesRoot: string,
  observer?: NativeFixtureAuditObserver,
): Promise<readonly NativeFixtureInventoryEntry[]> => {
  await rejectNestedSymlinkAncestry(harnessPackagesRoot);
  const physicalRoot = await realpath(harnessPackagesRoot);
  await observer?.("ancestry-after-resolution", physicalRoot);
  const ancestry = await stableExistingAncestry(physicalRoot);
  const entries: NativeFixtureInventoryEntry[] = [];
  await withStableDirectory(
    physicalRoot,
    false,
    async () => {
      const harnessDirectories = (
        await readdir(physicalRoot, { withFileTypes: true })
      ).sort((left, right) => left.name.localeCompare(right.name));
      for (const harnessDirectory of harnessDirectories) {
        if (harnessDirectory.name === "core") continue;
        if (!harnessDirectory.isDirectory())
          fail("harness.fixture.inventory.entry-kind");
        const packageRoot = join(physicalRoot, harnessDirectory.name);
        await withStableDirectory(
          packageRoot,
          false,
          async () => {
            const fixturesRoot = join(packageRoot, "fixtures");
            await withStableDirectory(
              fixturesRoot,
              true,
              async () => {
                const nativeRoot = join(fixturesRoot, "native");
                await withStableDirectory(
                  nativeRoot,
                  true,
                  async () => {
                    const files = (
                      await readdir(nativeRoot, { withFileTypes: true })
                    ).sort((left, right) =>
                      left.name.localeCompare(right.name),
                    );
                    for (const file of files) {
                      const relativePath = `${harnessDirectory.name}/fixtures/native/${file.name}`;
                      if (!file.isFile() || !file.name.endsWith(".json"))
                        fail("harness.fixture.inventory.entry-kind");
                      const bytes = await readStableFixtureFile(
                        join(nativeRoot, file.name),
                        observer,
                      );
                      const text = bytes.toString("utf8");
                      if (text.includes("\uFFFD") || contentIsForbidden(text))
                        fail("harness.fixture.inventory.content");
                      let input: unknown;
                      try {
                        input = JSON.parse(text);
                      } catch {
                        fail("harness.fixture.inventory.json");
                      }
                      const fixture = parseHarnessSanitizedFixture(input);
                      if (
                        fixture.harnessId !== harnessDirectory.name ||
                        basename(file.name, ".json") !== fixture.fixtureId
                      )
                        fail("harness.fixture.inventory.path-link");
                      if (serializeHarnessSanitizedFixture(fixture) !== text)
                        fail("harness.fixture.inventory.canonical-json");
                      entries.push(
                        Object.freeze({
                          harnessId: fixture.harnessId,
                          fixtureId: fixture.fixtureId,
                          harnessVersion: fixture.harnessVersion,
                          relativePath,
                          artifactAuthority:
                            fixture.governance.provenance.artifactAuthority
                              .status,
                          sha256: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
                        }),
                      );
                    }
                  },
                  observer,
                );
              },
              observer,
            );
          },
          observer,
        );
      }
    },
    observer,
  );
  await observer?.("ancestry-before-recheck", physicalRoot);
  await assertStableExistingAncestry(ancestry);
  return Object.freeze(
    entries.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
  );
};
