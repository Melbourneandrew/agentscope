import { createHash } from "node:crypto";
import { types } from "node:util";

import { LANGFUSE_COMPATIBILITY_MANIFEST } from "@agentscope/destination-langfuse";
import {
  readExternalOtlpJson,
  safeParseCanonicalTraceGraph,
  type CanonicalTraceGraph,
  type OtlpKeyValue,
} from "@agentscope/protocol";
import { z } from "zod";

import { deepFreeze } from "./canonical.js";
import { readSelectedWriterOtlpBatch } from "./operations.js";

const capsule = LANGFUSE_COMPATIBILITY_MANIFEST.capsule;
const projection = LANGFUSE_COMPATIBILITY_MANIFEST.projection;
const string = z.string().min(1).max(1024);
const contextField = z.strictObject({ key: string, value: string });
const expectedSchema = z.strictObject({
  harness: z.strictObject({ name: string, version: string }),
  sessionId: string,
  modelName: string.optional(),
  identity: z
    .strictObject({
      traceId: z.string().regex(/^[a-f0-9]{32}$/u),
      spanIds: z
        .array(z.string().regex(/^[a-f0-9]{16}$/u))
        .min(1)
        .max(256),
    })
    .optional(),
  resourceContext: z.array(contextField).max(32).optional(),
  rootContext: z.array(contextField).max(32).optional(),
  unavailableContext: z
    .array(
      z.strictObject({
        field: string,
        source: string,
        state: z.enum([
          "unavailable",
          "not-applicable",
          "redacted",
          "observed-empty",
        ]),
        reason: string,
      }),
    )
    .max(32)
    .optional(),
});

// Expectations come from the controller's held native/model/worktree evidence,
// never candidate success labels. Missing identity does not prove a native turn.
export type SelectedOtlpExpectation = z.infer<typeof expectedSchema>;
type RecordValue = Record<string, unknown>;
const refuse = (): never => {
  throw new Error("integration.operations.otlp-observation");
};
const record = (value: unknown): RecordValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refuse();
  return value as RecordValue;
};
const exact = (value: RecordValue, keys: readonly string[]) => {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    refuse();
};
const list = (value: unknown, maximum: number, minimum = 1): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return refuse();
  return value as unknown[];
};
const attributes = (value: unknown, maximum: number) => {
  const result = new Map<string, unknown>();
  for (const item of list(value, maximum)) {
    const entry = record(item);
    exact(entry, ["key", "value"]);
    if (typeof entry.key !== "string" || result.has(entry.key)) refuse();
    result.set(entry.key as string, entry.value);
  }
  return result;
};
const textValue = (value: unknown): string => {
  const entry = record(value);
  exact(entry, ["stringValue"]);
  if (typeof entry.stringValue !== "string") return refuse();
  return entry.stringValue;
};
const stringsValue = (value: unknown): string[] => {
  const entry = record(value);
  exact(entry, ["arrayValue"]);
  const array = record(entry.arrayValue);
  exact(array, ["values"]);
  return list(array.values, capsule.maximumChunksPerCarrier).map(textValue);
};
const metadataKey = (key: string) =>
  `${projection.wire.observationMetadataPrefix}${key}`;
const numberValue = (value: unknown, maximum: number) => {
  const text = textValue(value);
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(text) || Number(text) > maximum)
    return refuse();
  return Number(text);
};
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const checkTransportSpan = (input: unknown, root: RecordValue) => {
  const span = record(input);
  exact(span, [
    "traceId",
    "spanId",
    "parentSpanId",
    "name",
    "kind",
    "startTimeUnixNano",
    "endTimeUnixNano",
    "attributes",
    "droppedAttributesCount",
    "events",
    "droppedEventsCount",
    "links",
    "droppedLinksCount",
    "flags",
    "status",
  ]);
  if (
    typeof span.spanId !== "string" ||
    !/^[a-f0-9]{16}$/u.test(span.spanId) ||
    /^0+$/u.test(span.spanId) ||
    span.traceId !== root.traceId ||
    span.parentSpanId !== root.spanId ||
    span.kind !== 1 ||
    span.startTimeUnixNano !== root.startTimeUnixNano ||
    span.endTimeUnixNano !== root.startTimeUnixNano ||
    span.flags !== 0 ||
    span.droppedAttributesCount !== 0 ||
    span.droppedEventsCount !== 0 ||
    span.droppedLinksCount !== 0 ||
    !Array.isArray(span.events) ||
    span.events.length !== 0 ||
    !Array.isArray(span.links) ||
    span.links.length !== 0
  )
    refuse();
  const status = record(span.status);
  exact(status, ["code"]);
  if (status.code !== 0) refuse();
  return span;
};

// Classify every header overlay through the published finite contract. These
// presentation values are not an alternate semantic graph or native oracle.
const checkHeaderOverlays = (
  values: Map<string, unknown>,
  session: string,
  spanCount: number,
) => {
  const allowed = new Set<string>();
  const mirror = (key: string) => {
    const observation = metadataKey(key);
    const trace = `${projection.wire.traceMetadataPrefix}${key}`;
    allowed.add(observation);
    allowed.add(trace);
    const text = textValue(values.get(observation));
    if (textValue(values.get(trace)) !== text) refuse();
    return text;
  };
  if (
    mirror(projection.root) !== "true" ||
    mirror(projection.spanCount) !== String(spanCount) ||
    !["ok", "error", "unset"].includes(mirror(projection.status))
  )
    refuse();
  for (const key of [
    projection.harness,
    projection.branch,
    projection.repository,
  ])
    if (values.has(metadataKey(key))) mirror(key);
  for (const [countKey, indexPrefix, filterPrefix] of [
    [
      projection.modelCount,
      projection.modelIndexPrefix,
      projection.modelFilterKeyPrefix,
    ],
    [
      projection.tagCount,
      projection.tagIndexPrefix,
      projection.tagFilterKeyPrefix,
    ],
  ] as const) {
    const count = mirror(countKey);
    if (!new RegExp(projection.indexedCountGrammar, "u").test(count)) refuse();
    for (let index = 0; index < Number(count); index++) {
      const value = mirror(`${indexPrefix}${String(index).padStart(2, "0")}`);
      if (mirror(`${filterPrefix}${digest(value)}`) !== value) refuse();
    }
  }
  allowed.add(projection.wire.sessionAttribute);
  allowed.add(projection.wire.traceTagsAttribute);
  if (
    mirror(projection.session) !== session ||
    textValue(values.get(projection.wire.sessionAttribute)) !== session
  )
    refuse();
  for (const [key, value] of values) {
    if (!allowed.has(key)) refuse();
    if (key === projection.wire.sessionAttribute) continue;
    if (key === projection.wire.traceTagsAttribute) {
      if (stringsValue(value).some((tag) => tag.length > 200)) refuse();
      continue;
    }
    const text = textValue(value);
    if (
      text.length === 0 ||
      [...text].length > projection.maximumValueCharacters ||
      text.normalize("NFC") !== text ||
      [...text].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159);
      })
    )
      refuse();
  }
};

const checkCarriers = (
  spans: RecordValue[],
  chunks: string[],
  nonce: string,
  graphDigest: string,
  carrierCount: number,
) => {
  const seen = new Set<number>();
  for (const span of spans.filter((item) => item.name !== capsule.headerName)) {
    if (span.name !== capsule.carrierName) refuse();
    const fields = attributes(span.attributes, 5);
    const keys = [
      capsule.keys.nonce,
      capsule.keys.version,
      capsule.keys.graphDigest,
      capsule.keys.carrierIndex,
      capsule.keys.chunks,
    ].map(metadataKey);
    if (fields.size !== keys.length || keys.some((key) => !fields.has(key)))
      refuse();
    if (
      textValue(fields.get(keys[0]!)) !== nonce ||
      textValue(fields.get(keys[1]!)) !== capsule.version ||
      textValue(fields.get(keys[2]!)) !== graphDigest
    )
      refuse();
    const index = numberValue(
      fields.get(keys[3]!),
      capsule.maximumCarriers - 1,
    );
    if (index >= carrierCount || seen.has(index)) refuse();
    seen.add(index);
    const expected = chunks.slice(
      index * capsule.maximumChunksPerCarrier,
      (index + 1) * capsule.maximumChunksPerCarrier,
    );
    if (
      JSON.stringify(stringsValue(fields.get(keys[4]!))) !==
      JSON.stringify(expected)
    )
      refuse();
  }
};

const checkCapsule = (
  input: RecordValue,
  primary: RecordValue,
  root: RecordValue,
  session: string,
  primarySpans: RecordValue[],
) => {
  exact(input, ["resource", "scopeSpans"]);
  const resource = record(input.resource);
  exact(resource, ["attributes", "droppedAttributesCount"]);
  const routing = attributes(resource.attributes, 2);
  const originalRouting = attributes(record(primary.resource).attributes, 32);
  if (resource.droppedAttributesCount !== 0 || routing.size !== 2) refuse();
  for (const key of capsule.transportSpan.resourceAttributeKeys)
    if (
      JSON.stringify(routing.get(key)) !==
      JSON.stringify(originalRouting.get(key))
    )
      refuse();
  const scope = record(list(input.scopeSpans, 1)[0]);
  exact(scope, ["scope", "spans"]);
  exact(record(scope.scope), ["name"]);
  if (record(scope.scope).name !== capsule.scopeName) refuse();
  const spans = list(scope.spans, capsule.maximumCarriers + 1).map((span) =>
    checkTransportSpan(span, root),
  );
  const ids = new Set(primarySpans.map((span) => span.spanId as string));
  for (const span of spans) {
    const id = span.spanId as string;
    if (ids.has(id)) refuse();
    ids.add(id);
  }
  const headers = spans.filter((span) => span.name === capsule.headerName);
  if (headers.length !== 1) refuse();
  const header = attributes(
    headers[0]!.attributes,
    projection.maximumWireOverlayAttributes + 8,
  );
  const value = (key: string) => header.get(metadataKey(key));
  const nonce = textValue(value(capsule.keys.nonce));
  if (
    !new RegExp(capsule.nonceGrammar, "u").test(nonce) ||
    /^0+$/u.test(nonce) ||
    textValue(value(capsule.keys.marker)) !== capsule.marker ||
    textValue(value(capsule.keys.version)) !== capsule.version
  )
    refuse();
  const bytes = Buffer.from(JSON.stringify({ resourceSpans: [primary] }));
  const graphDigest = digest(bytes);
  const encoded = bytes.toString("base64url");
  const chunks = Array.from(
    { length: Math.ceil(encoded.length / capsule.chunkCharacters) },
    (_, index) =>
      encoded.slice(
        index * capsule.chunkCharacters,
        (index + 1) * capsule.chunkCharacters,
      ),
  );
  const carrierCount = Math.ceil(
    chunks.length / capsule.maximumChunksPerCarrier,
  );
  if (
    bytes.length > capsule.maximumGraphBytes ||
    numberValue(value(capsule.keys.graphBytes), capsule.maximumGraphBytes) !==
      bytes.length ||
    textValue(value(capsule.keys.graphDigest)) !== graphDigest ||
    numberValue(value(capsule.keys.chunkCount), 1000) !== chunks.length ||
    numberValue(value(capsule.keys.carrierCount), capsule.maximumCarriers) !==
      carrierCount ||
    spans.length !== carrierCount + 1
  )
    refuse();
  for (const key of [
    capsule.keys.marker,
    capsule.keys.nonce,
    capsule.keys.version,
    capsule.keys.graphBytes,
    capsule.keys.graphDigest,
    capsule.keys.carrierCount,
    capsule.keys.chunkCount,
  ])
    header.delete(metadataKey(key));
  checkHeaderOverlays(header, session, primarySpans.length);
  const rootFields = attributes(root.attributes, 128);
  for (const [key, original] of [
    [projection.harness, rootFields.get("agentscope.harness.name")],
    [projection.branch, originalRouting.get("vcs.ref.head.name")],
    [projection.repository, originalRouting.get("vcs.repository.name")],
  ] as const) {
    const projected = header.get(metadataKey(key));
    if (
      original === undefined
        ? projected !== undefined
        : textValue(projected) !== textValue(original)
    )
      refuse();
  }
  checkCarriers(spans, chunks, nonce, graphDigest, carrierCount);
  return { graphBytes: bytes.length, graphSha256: graphDigest, carrierCount };
};

const stringAttributes = (values: readonly OtlpKeyValue[] | undefined) =>
  Object.fromEntries(
    (values ?? []).flatMap(({ key, value }) =>
      "stringValue" in value ? [[key, value.stringValue]] : [],
    ),
  );
const checkContext = (
  graph: CanonicalTraceGraph,
  expected: SelectedOtlpExpectation,
) => {
  const resource = graph.resourceSpans[0]!;
  const spans = resource.scopeSpans[0]!.spans;
  const root = spans.find((span) => span.parentSpanId === undefined)!;
  const rootContext = stringAttributes(root.attributes);
  const resourceContext = stringAttributes(resource.resource?.attributes);
  // Strict Protocol validation above has already validated both complete
  // ledgers. Standard JSON projection preserves every entry; no private parser.
  const provenance = list(
    JSON.parse(rootContext["agentscope.mapping.provenance"]!),
    192,
  ).map(record);
  const unavailable =
    rootContext["agentscope.mapping.unavailable"] === undefined
      ? []
      : list(
          JSON.parse(rootContext["agentscope.mapping.unavailable"]),
          192,
          0,
        ).map(record);
  const models = spans.flatMap((span) => {
    const model = stringAttributes(span.attributes)["llm.model_name"];
    return model === undefined ? [] : [model];
  });
  if (
    rootContext["agentscope.harness.name"] !== expected.harness.name ||
    rootContext["agentscope.harness.version"] !== expected.harness.version ||
    rootContext["session.id"] !== expected.sessionId ||
    (models.length === 0) !== (expected.modelName === undefined) ||
    models.some((model) => model !== expected.modelName)
  )
    refuse();
  for (const [fields, actual] of [
    [expected.resourceContext, resourceContext],
    [expected.rootContext, rootContext],
  ] as const)
    for (const field of fields ?? [])
      if (actual[field.key] !== field.value) refuse();
  for (const field of expected.unavailableContext ?? []) {
    if (
      rootContext[field.field] !== undefined ||
      resourceContext[field.field] !== undefined ||
      !unavailable.some(
        (entry) =>
          entry.field === field.field &&
          entry.state === field.state &&
          entry.reason === field.reason,
      ) ||
      !provenance.some(
        (entry) => entry.field === field.field && entry.source === field.source,
      )
    )
      refuse();
  }
  if (
    expected.identity !== undefined &&
    (root.traceId !== expected.identity.traceId ||
      JSON.stringify(spans.map((span) => span.spanId)) !==
        JSON.stringify(expected.identity.spanIds))
  )
    refuse();
  return { rootContext, resourceContext, models, provenance, unavailable };
};

export const observeSelectedWriterOtlp = (
  bytes: Buffer,
  canaries: readonly string[],
  expectedInput: SelectedOtlpExpectation,
) => {
  try {
    // All raw privacy checks precede ANY schema normalization or partition.
    const batch = record(readSelectedWriterOtlpBatch(bytes, canaries));
    exact(batch, ["resourceSpans"]);
    if (types.isProxy(expectedInput)) refuse();
    const expected = expectedSchema.parse(expectedInput);
    const resources = list(batch.resourceSpans, 2, 2);
    const primary = resources.map(record).find((resource) => {
      const scopes = list(resource.scopeSpans, 1);
      return record(record(scopes[0]).scope).name !== capsule.scopeName;
    });
    if (primary === undefined) return refuse();
    if (!safeParseCanonicalTraceGraph({ resourceSpans: [primary] }).success)
      refuse();
    const read = readExternalOtlpJson(
      JSON.stringify({ resourceSpans: [primary] }),
    );
    if (!read.ok) return refuse();
    if (read.batch.units.length !== 1) return refuse();
    const unit = read.batch.units[0]!;
    if (unit.status !== "canonical") return refuse();
    const graph = unit.graph;
    const context = checkContext(graph, expected);
    const spans = list(record(list(primary.scopeSpans, 1)[0]).spans, 256).map(
      record,
    );
    const root = spans.find((span) => span.parentSpanId === undefined);
    if (root === undefined) return refuse();
    const transport = checkCapsule(
      record(resources.find((item) => item !== primary)),
      primary,
      root,
      expected.sessionId,
      spans,
    );
    return deepFreeze({
      graph,
      context,
      transport,
      resourceCount: resources.length,
      canonicalSpanCount: spans.length,
      transportSpanCount: transport.carrierCount + 1,
    });
  } catch {
    return refuse();
  }
};
