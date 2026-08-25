import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

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
    spdxExpression: string;
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

export type NativeFixtureAdmissionProvenance = Readonly<{
  captureKind: "disposable-hermetic";
  sourceReference: string;
  sourceArtifactDigest: string;
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

const idPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const fieldPattern = /^[a-z][a-z0-9_.-]{0,95}$/u;
const safeTokenPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const digestPattern = /^sha256-[a-f0-9]{64}$/u;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u;
const reviewReferencePattern = /^[a-z][a-z0-9._:/#-]{2,127}$/u;
const isoDatePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const syntheticReferencePattern =
  /^urn:agentscope:synthetic:[a-z0-9][a-z0-9._:-]{0,127}$/u;
const forbiddenPayloadKey =
  /(?:^|[_.-])(?:api[_-]?key|auth(?:orization)?|cookie|credential|message|password|prompt|raw|secret|stderr|stdout|terminal|transcript)(?:$|[_.-])/iu;
const forbiddenText =
  /(?:bearer\s|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret|sk-[a-z0-9]|ghp_[a-z0-9]|AKIA[0-9A-Z]|-----BEGIN|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.|file:\/\/|(?:^|\s)~[\\/]|(?:^|\s)\/(?:Users|home|private|root|tmp|Volumes)\/|[A-Za-z]:\\)/iu;
const removedCategories = Object.freeze([
  "credentials",
  "raw-transcript",
  "terminal-output",
  "user-content",
  "user-paths",
] as const);

const string = (value: unknown, pattern: RegExp, code: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value as string;
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

const sourceReference = (
  value: unknown,
  captureKind: "disposable-hermetic" | "synthetic",
): string => {
  if (typeof value !== "string" || value.length > 256)
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
      ["spdxExpression", "redistribution", "sourceReference"],
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

const admissionArtifactAuthority = (
  provenance: HarnessNativeFixtureProvenance,
): AuthenticatedArtifactAuthority => {
  if (
    provenance.captureKind !== "disposable-hermetic" ||
    provenance.artifactAuthority.status !== "authenticated"
  )
    fail("harness.fixture.provenance.admission-unresolved");
  return provenance.artifactAuthority as AuthenticatedArtifactAuthority;
};

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
    !Array.isArray(redaction.removedCategories) ||
    redaction.removedCategories.length !== removedCategories.length ||
    redaction.removedCategories.some(
      (category, index) => category !== removedCategories[index],
    )
  )
    fail("harness.fixture.redaction.categories");
  const references = review.references;
  if (
    !Array.isArray(references) ||
    references.length < 2 ||
    references.some(
      (reference) =>
        typeof reference !== "string" ||
        !reviewReferencePattern.test(reference),
    ) ||
    new Set(references).size !== references.length
  )
    fail("harness.fixture.review.references");
  const reviewedReferences = references as [string, string, ...string[]];
  return Object.freeze({
    provenance: parseProvenance(provenance),
    license: Object.freeze({
      spdxExpression: string(
        license.spdxExpression,
        spdxPattern,
        "harness.fixture.license.spdx",
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
    if (!fieldPattern.test(key) || forbiddenPayloadKey.test(key))
      fail("harness.fixture.payload.key");
    if (typeof member === "string") {
      if (!safeTokenPattern.test(member) || forbiddenText.test(member))
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
  const expectedInput = root.expectedFields;
  if (!Array.isArray(expectedInput) || expectedInput.length === 0)
    fail("harness.fixture.expected-fields");
  const expectedFieldsInput = expectedInput as unknown[];
  const expectedFields = expectedFieldsInput.map((field: unknown) =>
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

export const assertNativeFixtureAdmissionProvenance = (
  value: unknown,
): NativeFixtureAdmissionProvenance => {
  const fixture = parseHarnessSanitizedFixture(value);
  const { provenance } = fixture.governance;
  const artifactAuthority = admissionArtifactAuthority(provenance);
  return Object.freeze({
    captureKind: "disposable-hermetic" as const,
    sourceReference: provenance.sourceReference,
    sourceArtifactDigest: artifactAuthority.digest,
  });
};

export const auditNativeFixtureInventory = async (
  harnessPackagesRoot: string,
): Promise<readonly NativeFixtureInventoryEntry[]> => {
  const entries: NativeFixtureInventoryEntry[] = [];
  for (const harnessDirectory of await readdir(harnessPackagesRoot, {
    withFileTypes: true,
  })) {
    if (!harnessDirectory.isDirectory() || harnessDirectory.name === "core")
      continue;
    const nativeRoot = join(
      harnessPackagesRoot,
      harnessDirectory.name,
      "fixtures",
      "native",
    );
    let files;
    try {
      files = await readdir(nativeRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = `${harnessDirectory.name}/fixtures/native/${file.name}`;
      if (!file.isFile() || !file.name.endsWith(".json"))
        fail("harness.fixture.inventory.entry-kind");
      const path = join(nativeRoot, file.name);
      const identity = await lstat(path);
      if (identity.size > 65_536) fail("harness.fixture.inventory.file");
      const bytes = await readFile(path);
      const text = bytes.toString("utf8");
      if (text.includes("\uFFFD") || forbiddenText.test(text))
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
            fixture.governance.provenance.artifactAuthority.status,
          sha256: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
        }),
      );
    }
  }
  return Object.freeze(entries);
};
