import { standardsManifest } from "../standards/manifest.js";
import {
  parseCanonicalTraceGraph,
  type CanonicalTraceGraph,
} from "./canonical-graph.js";
import { parseFieldProvenance, type FieldProvenance } from "./context.js";
import {
  getDerivedIdentityBundleTopology,
  isDerivedIdentityBundle,
  type IdentityBundle,
} from "./identity.js";
import { deepFreeze } from "./immutable.js";
import type {
  CanonicalTraceEnvelope,
  RedactedCanonicalTrace,
} from "./redacted-envelope.js";
import { redactedCanonicalTraceRegistry } from "./redacted-registry.js";
import { CANONICAL_INPUT_BUDGET } from "./validation.js";

type FinalizationInput = Readonly<{
  identityBundle: IdentityBundle;
  /** Pre-final graph whose spans carry an internal logicalOperationKey. */
  graph: unknown;
}>;

type Budget = { nodes: number; stringCodeUnits: number };

const invalid = () => new Error("protocol.redacted-trace.invalid");
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const getPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;
const jsonStringify = JSON.stringify;

const copyPlainData = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: Budget,
): unknown => {
  budget.nodes += 1;
  if (
    budget.nodes > CANONICAL_INPUT_BUDGET.maximumNodes ||
    depth > CANONICAL_INPUT_BUDGET.maximumDepth
  ) {
    throw invalid();
  }
  if (typeof value === "string") {
    budget.stringCodeUnits += value.length;
    if (
      budget.stringCodeUnits > CANONICAL_INPUT_BUDGET.maximumStringCodeUnits
    ) {
      throw invalid();
    }
    return value;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") throw invalid();
  if (seen.has(value)) throw invalid();
  seen.add(value);
  const prototype = getPrototypeOf(value) as unknown;
  if (
    !arrayIsArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw invalid();
  }
  const descriptors = getOwnPropertyDescriptors(value);
  if (getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptorKeys = objectKeys(descriptors);
  const isArray = arrayIsArray(value);
  const entryCount = descriptorKeys.length - (isArray ? 1 : 0);
  if (entryCount > CANONICAL_INPUT_BUDGET.maximumObjectKeys) throw invalid();
  if (isArray) {
    const output: unknown[] = [];
    if (
      entryCount !== value.length ||
      descriptorKeys[descriptorKeys.length - 1] !== "length"
    ) {
      throw invalid();
    }
    for (let index = 0; index < entryCount; index += 1) {
      const key = descriptorKeys[index];
      /* v8 ignore next -- own array-index descriptors are returned in canonical numeric order. */
      if (key !== String(index)) throw invalid();
      const descriptor = descriptors[key];
      /* v8 ignore next -- a key returned by getOwnPropertyDescriptors always indexes a descriptor. */
      if (descriptor === undefined) throw invalid();
      if (!("value" in descriptor) || !descriptor.enumerable) throw invalid();
      output[index] = copyPlainData(descriptor.value, depth + 1, seen, budget);
    }
    return output;
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of descriptorKeys) {
    const descriptor = descriptors[key];
    budget.stringCodeUnits += key.length;
    if (
      budget.stringCodeUnits > CANONICAL_INPUT_BUDGET.maximumStringCodeUnits
    ) {
      throw invalid();
    }
    /* v8 ignore next -- a key returned by getOwnPropertyDescriptors always indexes a descriptor. */
    if (descriptor === undefined) throw invalid();
    if (!("value" in descriptor) || !descriptor.enumerable) throw invalid();
    output[key] = copyPlainData(descriptor.value, depth + 1, seen, budget);
  }
  return output;
};

const exactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || arrayIsArray(value))
    throw invalid();
  const record = value as Record<string, unknown>;
  if (
    getPrototypeOf(record) !== Object.prototype ||
    getOwnPropertySymbols(record).length !== 0
  )
    throw invalid();
  const descriptors = getOwnPropertyDescriptors(record);
  const keys = objectKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return (
        !objectHasOwn(descriptors, key) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      );
    })
  ) {
    throw invalid();
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys)
    output[key] = (
      descriptors[key] as PropertyDescriptor & { value: unknown }
    ).value;
  return output;
};

const innerManifestId = (graph: CanonicalTraceGraph) => {
  /* v8 ignore next -- strict canonical validation requires the singular resource and resource attributes before this independent envelope cross-check. */
  const attributes = graph.resourceSpans[0]!.resource?.attributes ?? [];
  const value = attributes.find(
    ({ key }) => key === "agentscope.protocol.manifest_id",
  )?.value;
  /* v8 ignore next -- strict canonical validation already requires this exact string attribute; keep the fallback as defense in depth. */
  return value !== undefined && "stringValue" in value
    ? value.stringValue
    : undefined;
};

const injectDerivedProvenance = (
  span: Record<string, unknown>,
  fields: readonly string[],
) => {
  const attributes = span.attributes;
  if (!arrayIsArray(attributes)) throw invalid();
  let attribute: Record<string, unknown> | undefined;
  for (const candidate of attributes) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).key ===
        "agentscope.mapping.provenance"
    ) {
      if (attribute !== undefined) throw invalid();
      attribute = candidate as Record<string, unknown>;
    }
  }
  if (attribute === undefined) throw invalid();
  const value = attribute.value;
  if (typeof value !== "object" || value === null) throw invalid();
  const stringValue = (value as Record<string, unknown>).stringValue;
  if (typeof stringValue !== "string") throw invalid();
  const parsed = parseFieldProvenance(stringValue);
  if (!parsed.success) throw invalid();
  const ledger: FieldProvenance = [];
  for (const entry of parsed.data) ledger.push(entry);
  for (const field of fields) {
    let existing: FieldProvenance[number] | undefined;
    for (const entry of ledger) {
      if (entry.field === field) existing = entry;
    }
    if (existing !== undefined && existing.source !== "derived")
      throw invalid();
    if (existing === undefined) ledger.push({ field, source: "derived" });
  }
  for (let left = 0; left < ledger.length; left += 1) {
    for (let right = left + 1; right < ledger.length; right += 1) {
      if (ledger[right]!.field < ledger[left]!.field) {
        const swap = ledger[left]!;
        ledger[left] = ledger[right]!;
        ledger[right] = swap;
      }
    }
  }
  (value as Record<string, unknown>).stringValue = jsonStringify(ledger);
};

const injectLinkIdentity = (
  candidate: unknown,
  topology: Readonly<Record<string, string | undefined>>,
  bundle: IdentityBundle,
) => {
  if (typeof candidate !== "object" || candidate === null) throw invalid();
  const link = candidate as Record<string, unknown>;
  const targetLogicalKey = link.targetLogicalKey;
  if (targetLogicalKey === undefined) {
    if (!objectHasOwn(link, "traceId") || !objectHasOwn(link, "spanId"))
      throw invalid();
    return false;
  }
  if (
    typeof targetLogicalKey !== "string" ||
    !objectHasOwn(topology, targetLogicalKey)
  )
    throw invalid();
  Reflect.deleteProperty(link, "targetLogicalKey");
  link.traceId = bundle.traceId;
  link.spanId = bundle.spans[targetLogicalKey];
  return true;
};

const injectGraphIdentity = (value: unknown, bundle: IdentityBundle) => {
  const topology = getDerivedIdentityBundleTopology(bundle);
  /* v8 ignore next -- the preceding runtime bundle registry check guarantees its paired topology entry. */
  if (topology === undefined) throw invalid();
  const graph = value as Record<string, unknown>;
  const resourceSpans = graph.resourceSpans;
  if (!arrayIsArray(resourceSpans) || resourceSpans.length !== 1)
    throw invalid();
  const resource = resourceSpans[0] as Record<string, unknown>;
  const scopeSpans = resource.scopeSpans;
  if (!arrayIsArray(scopeSpans) || scopeSpans.length !== 1) throw invalid();
  const scope = scopeSpans[0] as Record<string, unknown>;
  const spans = scope.spans;
  if (!arrayIsArray(spans)) throw invalid();
  const remainingKeys = new Set(objectKeys(topology));
  if (remainingKeys.size !== spans.length) throw invalid();
  for (const candidate of spans) {
    if (typeof candidate !== "object" || candidate === null) throw invalid();
    const span = candidate as Record<string, unknown>;
    const logicalKey = span.logicalOperationKey;
    if (typeof logicalKey !== "string" || !remainingKeys.delete(logicalKey))
      throw invalid();
    Reflect.deleteProperty(span, "logicalOperationKey");
    span.traceId = bundle.traceId;
    span.spanId = bundle.spans[logicalKey];
    const parentLogicalKey = topology[logicalKey];
    if (parentLogicalKey === undefined)
      Reflect.deleteProperty(span, "parentSpanId");
    else span.parentSpanId = bundle.spans[parentLogicalKey];
    const links = span.links;
    const derivedFields = ["span.trace_id", "span.span_id"];
    if (parentLogicalKey !== undefined)
      derivedFields.push("span.parent_span_id");
    if (links !== undefined) {
      if (!arrayIsArray(links)) throw invalid();
      let hasInternalTarget = false;
      for (const candidateLink of links)
        hasInternalTarget =
          injectLinkIdentity(candidateLink, topology, bundle) ||
          hasInternalTarget;
      if (hasInternalTarget) derivedFields.push("span.links.target_ids");
    }
    injectDerivedProvenance(span, derivedFields);
  }
  /* v8 ignore next -- equal cardinality plus unique successful deletion exhausts the set. */
  if (remainingKeys.size !== 0) throw invalid();
  return value;
};

export const finalizeRedactedCanonicalTrace = (
  input: FinalizationInput,
): RedactedCanonicalTrace => {
  try {
    const fields = exactRecord(input, ["identityBundle", "graph"]);
    if (!isDerivedIdentityBundle(fields.identityBundle)) throw invalid();
    const identityBundle = fields.identityBundle;
    const copiedGraph = copyPlainData(fields.graph, 0, new WeakSet(), {
      nodes: 0,
      stringCodeUnits: 0,
    });
    const graph = parseCanonicalTraceGraph(
      injectGraphIdentity(copiedGraph, identityBundle),
    );
    /* v8 ignore next -- the graph parser also checks the current manifest; this explicit outer/inner equality is a second invariant. */
    if (innerManifestId(graph) !== standardsManifest.manifestId)
      throw invalid();
    const result = deepFreeze({
      envelopeVersion: 1 as const,
      protocolManifestId: standardsManifest.manifestId,
      delivery: {
        identity: identityBundle.deliveryId,
        stability: identityBundle.stability,
      },
      graph,
    }) as CanonicalTraceEnvelope;
    redactedCanonicalTraceRegistry.add(result);
    return result as RedactedCanonicalTrace;
  } catch {
    throw invalid();
  }
};
