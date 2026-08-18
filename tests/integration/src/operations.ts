import { z } from "zod";

import { deepFreeze } from "./canonical.js";
import type { CapabilitySelector } from "./manifest.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const requestPath = z.string().regex(/^\/[a-zA-Z0-9._~:/-]{0,255}$/u);
const byteCount = z
  .number()
  .int()
  .min(0)
  .max(16 * 1024 * 1024);
const scenarioToken = z.string().regex(/^[a-f\d]{16}$/u);
const bundleIdentity = z.string().regex(/^sha256-[a-f\d]{64}$/u);

const modelEntry = z.strictObject({
  routeId: id,
  provider: id,
  method: z.enum(["GET", "POST"]),
  path: requestPath,
  bodyBytes: byteCount,
});
const destinationEntry = z.strictObject({
  operation: z.enum([
    "otlp-ingest",
    "langfuse-ingest",
    "seed",
    "search",
    "get",
  ]),
  method: z.enum(["GET", "POST"]),
  path: requestPath,
  bodyBytes: byteCount,
  outcome: z.enum([
    "accepted",
    "auth-rejected",
    "rate-limited",
    "unavailable",
    "malformed-response",
  ]),
});
const lifecycle = z.tuple([
  z.literal("install"),
  z.literal("configure"),
  z.literal("hook"),
  z.literal("execute"),
  z.literal("export"),
  z.literal("retrieve"),
  z.literal("uninstall"),
]);
const eventKinds = z.tuple([
  z.literal("hook"),
  z.literal("canonical"),
  z.literal("redaction"),
  z.literal("git"),
  z.literal("model"),
  z.literal("tool"),
  z.literal("destination"),
]);
const fixtureResult = z.strictObject({
  evidenceVersion: z.literal(1),
  scenarioId: id,
  artifactFileName: z.string().regex(/^agentscope-cli(?:-[0-9.]+)?\.tgz$/u),
  lifecycle,
  eventKinds,
  modelLedger: z.strictObject({
    ledgerVersion: z.literal(1),
    scenarioId: id,
    entries: z.array(modelEntry).min(1).max(32),
  }),
  destinationLedger: z.strictObject({
    ledgerVersion: z.literal(1),
    scenarioId: id,
    ingestion: z.array(destinationEntry).min(1).max(32),
    retrieval: z.array(destinationEntry).min(1).max(32),
  }),
});

export type SanitizedFixtureResult = z.infer<typeof fixtureResult>;

export const sanitizeFixtureResult = (
  input: unknown,
  scenarioId: string,
): Readonly<SanitizedFixtureResult> => {
  const parsed = fixtureResult.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.scenarioId !== scenarioId ||
    parsed.data.modelLedger.scenarioId !== scenarioId ||
    parsed.data.destinationLedger.scenarioId !== scenarioId
  )
    throw new Error("integration.operations.fixture-result");
  return deepFreeze(structuredClone(parsed.data));
};

export const mapWithConcurrency = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> => {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16 ||
    inputs.length > 256
  )
    throw new Error("integration.operations.concurrency");
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input === undefined)
        throw new Error("integration.operations.concurrency");
      results[index] = await operation(input, index);
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, inputs.length) }, worker),
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) {
    if (failure.reason instanceof Error) throw failure.reason;
    throw new Error("integration.operations.concurrency");
  }
  return deepFreeze(results);
};

export interface LocalSelection {
  readonly mode: "scenario" | "harness" | "tag" | "shard" | "full";
  readonly selector: Readonly<CapabilitySelector>;
}

export const compileLocalSelection = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<LocalSelection> => {
  let shard: CapabilitySelector["shard"];
  const shardValue = environment.AGENTSCOPE_INTEGRATION_SHARD;
  if (shardValue !== undefined) {
    const match = /^(\d+)\/(\d+)$/u.exec(shardValue);
    if (!match) throw new Error("integration.manifest.shard");
    shard = { index: Number(match[1]), total: Number(match[2]) };
  }
  const full = environment.AGENTSCOPE_INTEGRATION_FULL;
  if (full !== undefined && full !== "1")
    throw new Error("integration.manifest.selector");
  const candidates: LocalSelection[] = [
    ...(environment.AGENTSCOPE_INTEGRATION_SCENARIO === undefined
      ? []
      : [
          {
            mode: "scenario" as const,
            selector: {
              scenarioId: environment.AGENTSCOPE_INTEGRATION_SCENARIO,
            },
          },
        ]),
    ...(environment.AGENTSCOPE_INTEGRATION_HARNESS === undefined
      ? []
      : [
          {
            mode: "harness" as const,
            selector: {
              harnessId: environment.AGENTSCOPE_INTEGRATION_HARNESS,
            },
          },
        ]),
    ...(environment.AGENTSCOPE_INTEGRATION_TAG === undefined
      ? []
      : [
          {
            mode: "tag" as const,
            selector: { tag: environment.AGENTSCOPE_INTEGRATION_TAG },
          },
        ]),
    ...(shard === undefined
      ? []
      : [{ mode: "shard" as const, selector: { shard } }]),
    ...(full === "1" ? [{ mode: "full" as const, selector: {} }] : []),
  ];
  if (candidates.length !== 1) throw new Error("integration.manifest.selector");
  return deepFreeze(candidates[0]!);
};

export type ArtifactCollection = "candidates" | "contexts" | "runs";

export const ARTIFACT_RETENTION_LIMITS = deepFreeze({
  candidates: 4,
  contexts: 0,
  runs: 16,
} as const);

export interface ArtifactDirectoryEntry {
  readonly collection: ArtifactCollection;
  readonly name: string;
  readonly modifiedMilliseconds: number;
  readonly bytes: number;
}

export interface ArtifactRetentionPlan {
  readonly totalBytes: number;
  readonly remove: readonly ArtifactDirectoryEntry[];
  readonly retain: readonly ArtifactDirectoryEntry[];
}

const artifactNameIsValid = (
  collection: ArtifactCollection,
  name: string,
): boolean =>
  collection === "candidates"
    ? bundleIdentity.safeParse(name).success
    : scenarioToken.safeParse(name).success;

export const planArtifactRetention = (
  entries: readonly ArtifactDirectoryEntry[],
  currentCandidate?: string,
): Readonly<ArtifactRetentionPlan> => {
  if (
    entries.length > 1024 ||
    (currentCandidate !== undefined &&
      !bundleIdentity.safeParse(currentCandidate).success)
  )
    throw new Error("integration.operations.artifacts");
  const retain: ArtifactDirectoryEntry[] = [];
  const remove: ArtifactDirectoryEntry[] = [];
  for (const collection of ["candidates", "contexts", "runs"] as const) {
    const candidates = entries
      .filter((entry) => entry.collection === collection)
      .map((entry) => {
        if (
          !artifactNameIsValid(collection, entry.name) ||
          !Number.isSafeInteger(entry.modifiedMilliseconds) ||
          entry.modifiedMilliseconds < 0 ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 0
        )
          throw new Error("integration.operations.artifacts");
        return entry;
      })
      .sort(
        (left, right) =>
          right.modifiedMilliseconds - left.modifiedMilliseconds ||
          left.name.localeCompare(right.name),
      );
    const limit = ARTIFACT_RETENTION_LIMITS[collection];
    const protectedName =
      collection === "candidates" ? currentCandidate : undefined;
    const keep = new Set(
      candidates
        .filter(({ name }) => name === protectedName)
        .concat(candidates.filter(({ name }) => name !== protectedName))
        .slice(0, limit)
        .map(({ name }) => name),
    );
    for (const entry of candidates)
      (keep.has(entry.name) ? retain : remove).push(entry);
  }
  return deepFreeze({
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    remove,
    retain,
  });
};
