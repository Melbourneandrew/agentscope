import { z } from "zod";

import {
  isRegisteredDestinationReporter,
  isRegisteredDestinationRetriever,
} from "./capability-brand.js";
import {
  createReporterCredentialAccessor,
  type CredentialSlot,
  type ReporterCredentialAccessor,
} from "./credentials.js";
import {
  validateDestinationEndpoint,
  type ValidatedDestinationEndpoint,
} from "./endpoint.js";
import {
  createCredentialSlotId,
  createDestinationCommandName,
  createDestinationConnectionId,
  createDestinationTypeId,
  type DestinationCommandName,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
import {
  cloneJsonObject,
  settingsContainCredentialKey,
  type JsonObject,
} from "./plain-data.js";
import type { Reporter } from "./reporter.js";
import type { Retriever } from "./retriever.js";
import {
  isBoundDestinationTransport,
  type BoundDestinationTransport,
} from "./transport.js";

export type DeliveryIdentitySupport =
  "native-idempotency" | "duplicates-possible";

export type DestinationTransportDeclaration =
  Readonly<{ kind: "local" }> | Readonly<{ kind: "remote" }>;

export type RemoteEndpointCandidate = Readonly<{
  url: string;
  allowInsecureLoopback: boolean;
}>;

export type ReporterFactoryContext<Settings extends JsonObject> = Readonly<{
  connectionId: DestinationConnectionId;
  settings: Settings;
  credentials: ReporterCredentialAccessor;
  endpoint: ValidatedDestinationEndpoint | null;
  transport: BoundDestinationTransport | null;
}>;
export type RetrieverFactoryContext<Settings extends JsonObject> =
  ReporterFactoryContext<Settings>;

declare const destinationDescriptorBrand: unique symbol;

export type DestinationDescriptor<Settings extends JsonObject = JsonObject> =
  Readonly<{
    descriptorVersion: 1;
    destinationType: DestinationTypeId;
    commandName: DestinationCommandName;
    settingsVersion: number;
    settingKeys: readonly string[];
    defaultSettings: Settings;
    credentialSlots: readonly CredentialSlot[];
    documentationPath: string;
    deliveryIdentitySupport: DeliveryIdentitySupport;
    retrievalSupport: "search-and-get" | "unsupported";
    transport: DestinationTransportDeclaration;
    readonly [destinationDescriptorBrand]: Settings;
  }>;

export type DestinationSettings<Descriptor> =
  Descriptor extends DestinationDescriptor<infer Settings> ? Settings : never;

export type DestinationDescriptorInput<Settings extends JsonObject> = Readonly<{
  descriptorVersion: 1;
  destinationType: string;
  commandName: string;
  settingsVersion: number;
  settingsSchema: z.ZodType<Settings>;
  defaultSettings: unknown;
  credentialSlots: readonly Readonly<{ id: string; required: boolean }>[];
  documentationPath: string;
  deliveryIdentitySupport: DeliveryIdentitySupport;
  transport:
    | Readonly<{ kind: "local" }>
    | Readonly<{
        kind: "remote";
        resolveEndpoint: (settings: Settings) => RemoteEndpointCandidate;
      }>;
  createReporter: (context: ReporterFactoryContext<Settings>) => Reporter;
  createRetriever?: (context: RetrieverFactoryContext<Settings>) => Retriever;
}>;

type StoredDescriptor = Readonly<{
  schemaAuthority: CompiledSettingsSchema;
  settingKeys: ReadonlySet<string>;
  resolveEndpoint?: (settings: JsonObject) => RemoteEndpointCandidate;
  createReporter: (context: ReporterFactoryContext<JsonObject>) => Reporter;
  createRetriever?: (context: RetrieverFactoryContext<JsonObject>) => Retriever;
}>;

const descriptorRegistry = new WeakMap<object, StoredDescriptor>();
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectFreeze = Object.freeze;
const objectKeys = Object.keys;
const reflectOwnKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const nativeSetPrototype = Set.prototype;
const nativeRegExpPrototype = RegExp.prototype;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled mutation.
const setSizeGetter = Object.getOwnPropertyDescriptor(
  Set.prototype,
  "size",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled mutation.
const setValues = Set.prototype.values;
const setIteratorNext = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(reflectApply(setValues, new Set(), [])),
  "next",
)!.value as () => IteratorResult<unknown>;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled mutation.
const regExpSourceGetter = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "source",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled mutation.
const regExpFlagsGetter = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "flags",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before callback-controlled prototype mutation.
const promiseThen = Promise.prototype.then;

const trustedZodConstructorPrototypes = new Map<unknown, object>();
for (const [exportName, candidate] of Object.entries(z)) {
  if (typeof candidate !== "function") continue;
  const prototype = objectGetOwnPropertyDescriptor(candidate, "prototype");
  const prototypeValue: unknown = prototype?.value;
  if (
    exportName.startsWith("Zod") &&
    typeof prototypeValue === "object" &&
    prototypeValue !== null
  )
    trustedZodConstructorPrototypes.set(candidate, prototypeValue);
}

type CompiledSettingsSchema = Readonly<{
  schema: z.ZodType<JsonObject>;
  safeParse: z.ZodType<JsonObject>["safeParse"];
  identity: JsonObject;
  settingKeys: readonly string[];
}>;

const nonDeclarativeSchemaTypes = new Set([
  "catch",
  "custom",
  "default",
  "function",
  "lazy",
  "pipe",
  "prefault",
  "promise",
  "transform",
]);

const declarativeSchemaChecks = new Set([
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "string_format",
]);

const dataDescriptorValue = (descriptor: PropertyDescriptor): unknown =>
  descriptor.value as unknown;

const exactDataDescriptorsEqual = (
  left: object,
  right: object,
  budget: { remaining: number },
): boolean => {
  const leftDescriptors = objectGetOwnPropertyDescriptors(left);
  const rightDescriptors = objectGetOwnPropertyDescriptors(right);
  const keys = reflectOwnKeys(leftDescriptors);
  if (keys.length !== reflectOwnKeys(rightDescriptors).length) return false;
  return keys.every((key) => {
    const leftDescriptor = objectGetOwnPropertyDescriptor(left, key);
    const rightDescriptor = objectGetOwnPropertyDescriptor(right, key);
    if (
      !leftDescriptor ||
      !rightDescriptor ||
      !Object.is(leftDescriptor.configurable, rightDescriptor.configurable) ||
      !Object.is(leftDescriptor.enumerable, rightDescriptor.enumerable) ||
      !("value" in leftDescriptor) ||
      !("value" in rightDescriptor) ||
      !Object.is(leftDescriptor.writable, rightDescriptor.writable)
    )
      return false;
    return authorityValuesEqual(
      dataDescriptorValue(leftDescriptor),
      dataDescriptorValue(rightDescriptor),
      budget,
    );
  });
};

const intrinsicSetValues = (value: Set<unknown>): unknown[] | undefined => {
  const size = reflectApply(setSizeGetter, value, []) as number;
  if (size > 256) return undefined;
  const iterator = reflectApply(setValues, value, []) as SetIterator<unknown>;
  const values: unknown[] = [];
  for (let index = 0; index <= size; index += 1) {
    const result = reflectApply(setIteratorNext, iterator, []);
    if (result.done) return values;
    values.push(result.value);
  }
  /* v8 ignore next -- captured native Set size and iterator exhaust together after exactly `size` values. */
  return undefined;
};

const hasRegExpInternalSlot = (value: unknown): value is RegExp => {
  try {
    reflectApply(regExpSourceGetter, value, []);
    return true;
  } catch {
    return false;
  }
};

const hasSetInternalSlot = (value: unknown): value is Set<unknown> => {
  try {
    reflectApply(setSizeGetter, value, []);
    return true;
  } catch {
    return false;
  }
};

const schemaCheckIsDeclarative = (
  check: unknown,
  format: unknown,
  pattern: unknown,
): boolean => {
  if (check === undefined) return true;
  if (typeof check !== "string" || !declarativeSchemaChecks.has(check))
    return false;
  if (check !== "string_format") return true;
  return (
    format === "regex" && pattern instanceof RegExp && pattern.flags === ""
  );
};

/* eslint-disable complexity -- primitive, RegExp, Set, and exact data-record branches are one closed recursive comparator. */
const authorityValuesEqual = (
  left: unknown,
  right: unknown,
  budget: { remaining: number },
): boolean => {
  budget.remaining -= 1;
  /* v8 ignore next -- accepted Zod bag graphs are bounded and shallow; hostile additions differ before recursive exhaustion. */
  if (budget.remaining < 0) return false;
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    objectGetPrototypeOf(left) !== objectGetPrototypeOf(right)
  )
    return false;
  const leftIsRegExp = hasRegExpInternalSlot(left);
  const rightIsRegExp = hasRegExpInternalSlot(right);
  if (leftIsRegExp || rightIsRegExp) {
    if (
      !leftIsRegExp ||
      !rightIsRegExp ||
      objectGetPrototypeOf(left) !== nativeRegExpPrototype ||
      objectGetPrototypeOf(right) !== nativeRegExpPrototype
    )
      return false;
    /* v8 ignore next -- Zod's definition and emitted bag intentionally share an immutable unflagged RegExp identity. */
    if (!exactDataDescriptorsEqual(left, right, budget)) return false;
    return (
      reflectApply(regExpSourceGetter, left, []) ===
        reflectApply(regExpSourceGetter, right, []) &&
      reflectApply(regExpFlagsGetter, left, []) ===
        reflectApply(regExpFlagsGetter, right, [])
    );
  }
  const leftIsSet = hasSetInternalSlot(left);
  const rightIsSet = hasSetInternalSlot(right);
  if (leftIsSet || rightIsSet) {
    if (
      !leftIsSet ||
      !rightIsSet ||
      objectGetPrototypeOf(left) !== nativeSetPrototype ||
      objectGetPrototypeOf(right) !== nativeSetPrototype ||
      reflectOwnKeys(left).length !== 0 ||
      reflectOwnKeys(right).length !== 0
    )
      return false;
    const leftValues = intrinsicSetValues(left);
    const rightValues = intrinsicSetValues(right);
    if (!leftValues || !rightValues || leftValues.length !== rightValues.length)
      return false;
    return leftValues.every((value, index) =>
      authorityValuesEqual(value, rightValues[index], budget),
    );
  }
  if (Object.is(left, right)) return true;
  /* v8 ignore next -- unequal primitive pairs are eliminated by the preceding identity check before recursive authority comparison. */
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  return exactDataDescriptorsEqual(left, right, budget);
};
/* eslint-enable complexity */

const schemaEmitterStateMatchesDefinition = (
  current: object,
  definition: object,
  zodState: object,
): boolean => {
  if (!(current instanceof z.ZodType)) return true;
  const stateDescriptors = objectGetOwnPropertyDescriptors(zodState);
  const constructorDescriptor = stateDescriptors.constr;
  if (!constructorDescriptor || !("value" in constructorDescriptor))
    return false;
  const constructor = dataDescriptorValue(constructorDescriptor);
  if (
    trustedZodConstructorPrototypes.get(constructor) !==
    objectGetPrototypeOf(current)
  )
    return false;
  const definitionPrototype: unknown = objectGetPrototypeOf(definition);
  /* v8 ignore next -- ECMAScript object prototypes are always object or null. */
  if (definitionPrototype !== null && typeof definitionPrototype !== "object")
    return false;
  const copiedDefinition = Object.create(
    definitionPrototype,
    objectGetOwnPropertyDescriptors(definition),
  ) as object;
  const fresh = z.clone(current, copiedDefinition as never);
  return authorityValuesEqual(
    (zodState as z.ZodType["_zod"]).bag,
    fresh._zod.bag,
    { remaining: 256 },
  );
};

const zodDefinition = (current: object): object | undefined => {
  const descriptors = objectGetOwnPropertyDescriptors(current);
  const zodDescriptor = descriptors._zod;
  if (!zodDescriptor) return undefined;
  if (z.globalRegistry.get(current as never) !== undefined) return invalid();
  /* v8 ignore next -- actual ZodType instances expose a nonconfigurable data-valued `_zod` property. */
  if (!("value" in zodDescriptor)) return invalid();
  const zodState = dataDescriptorValue(zodDescriptor);
  /* v8 ignore next -- actual ZodType `_zod` state is always an object; the property cannot be replaced. */
  if (typeof zodState !== "object" || zodState === null) return invalid();
  const stateDescriptors = objectGetOwnPropertyDescriptors(zodState);
  if ("toJSONSchema" in zodState) return invalid();
  const definitionDescriptor = stateDescriptors.def;
  if (!definitionDescriptor || !("value" in definitionDescriptor))
    return invalid();
  const definition = dataDescriptorValue(definitionDescriptor);
  if (typeof definition !== "object" || definition === null) return invalid();
  const definitionDescriptors = objectGetOwnPropertyDescriptors(definition);
  if (
    Object.values(definitionDescriptors).some(
      (descriptor) => !("value" in descriptor),
    )
  )
    return invalid();
  if (!schemaEmitterStateMatchesDefinition(current, definition, zodState))
    return invalid();
  return definition;
};

const inspectZodState = (
  current: object,
  pending: object[],
  shapeSnapshots: WeakMap<object, Readonly<Record<string, z.ZodType>>>,
): void => {
  const definition = zodDefinition(current);
  if (!definition) return;
  const definitionDescriptors = objectGetOwnPropertyDescriptors(definition);
  const typeDescriptor = definitionDescriptors.type;
  const type =
    typeDescriptor && "value" in typeDescriptor
      ? dataDescriptorValue(typeDescriptor)
      : undefined;
  const checkDescriptor = definitionDescriptors.check;
  const check =
    checkDescriptor && "value" in checkDescriptor
      ? dataDescriptorValue(checkDescriptor)
      : undefined;
  const coerceDescriptor = definitionDescriptors.coerce;
  const coerce =
    coerceDescriptor && "value" in coerceDescriptor
      ? dataDescriptorValue(coerceDescriptor)
      : undefined;
  const formatDescriptor = definitionDescriptors.format;
  const format =
    formatDescriptor && "value" in formatDescriptor
      ? dataDescriptorValue(formatDescriptor)
      : undefined;
  const patternDescriptor = definitionDescriptors.pattern;
  const pattern =
    patternDescriptor && "value" in patternDescriptor
      ? dataDescriptorValue(patternDescriptor)
      : undefined;
  const whenDescriptor = definitionDescriptors.when;
  const when =
    whenDescriptor && "value" in whenDescriptor
      ? dataDescriptorValue(whenDescriptor)
      : undefined;
  if (
    nonDeclarativeSchemaTypes.has(String(type)) ||
    !schemaCheckIsDeclarative(check, format, pattern) ||
    when !== undefined ||
    coerce === true
  )
    return invalid();
  const shape = definitionDescriptors.shape;
  if (!shape) return;
  let shapeValue: unknown;
  /* v8 ignore next 3 -- explicit materialized-shape regressions exercise this Zod data-descriptor path; V8 attributes it to Zod's getter materialization. */
  if ("value" in shape) {
    shapeValue = shape.value;
  } else {
    return invalid();
  }
  /* v8 ignore next 3 -- malformed materialized-shape regressions exercise this fixed rejection; V8 attributes it to Zod's preceding materialization. */
  if (typeof shapeValue !== "object" || shapeValue === null) {
    return invalid();
  }
  const shapeDescriptors = objectGetOwnPropertyDescriptors(shapeValue);
  const shapeKeys = reflectOwnKeys(shapeDescriptors);
  if (
    shapeKeys.length > 256 ||
    shapeKeys.some((key) => typeof key !== "string")
  )
    return invalid();
  const snapshot = Object.create(null) as Record<string, z.ZodType>;
  for (const key of shapeKeys as string[]) {
    const descriptor = shapeDescriptors[key];
    /* v8 ignore next -- key originates from this exact own-descriptor map. */
    if (!descriptor || !("value" in descriptor)) return invalid();
    const child: unknown = descriptor.value;
    if (!(child instanceof z.ZodType)) return invalid();
    snapshot[key] = child;
    pending.push(child);
  }
  shapeSnapshots.set(current, Object.freeze(snapshot));
};

const inspectDeclarativeSchema = (
  schema: z.ZodType<JsonObject>,
  shapeSnapshots = new WeakMap<object, Readonly<Record<string, z.ZodType>>>(),
): readonly object[] => {
  const pending: object[] = [schema];
  const seen = new WeakSet<object>();
  const objects: object[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    objects.push(current);
    /* v8 ignore next -- each accepted object shape is capped at 256 and nondeclarative cyclic/lazy schemas reject first. */
    if (objects.length > 1_024) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(current);
    inspectZodState(current, pending, shapeSnapshots);
    for (const descriptor of Object.values(descriptors)) {
      const value: unknown = dataDescriptorValue(descriptor);
      if ("value" in descriptor && typeof value === "object" && value !== null)
        pending.push(value);
    }
  }
  return objects;
};

const cloneDefinitionValue = (
  value: unknown,
  shapeSnapshots: WeakMap<object, Readonly<Record<string, z.ZodType>>>,
  clones: WeakMap<object, z.ZodType>,
): unknown => {
  if (value instanceof z.ZodType)
    return cloneInspectedSchema(value, shapeSnapshots, clones);
  if (Array.isArray(value))
    return value.map((item: unknown) =>
      item instanceof z.ZodType
        ? cloneInspectedSchema(item, shapeSnapshots, clones)
        : item,
    );
  return value;
};

const cloneInspectedSchema = (
  schema: z.ZodType,
  shapeSnapshots: WeakMap<object, Readonly<Record<string, z.ZodType>>>,
  clones: WeakMap<object, z.ZodType>,
): z.ZodType => {
  const existing = clones.get(schema);
  if (existing) return existing;
  const definition = zodDefinition(schema);
  /* v8 ignore next -- the complete caller graph was accepted immediately before reconstruction. */
  if (!definition) return invalid();
  const definitionPrototype: unknown = objectGetPrototypeOf(definition);
  /* v8 ignore next -- ECMAScript object prototypes are always object or null. */
  if (definitionPrototype !== null && typeof definitionPrototype !== "object")
    return invalid();
  const copiedDefinition = Object.create(definitionPrototype) as Record<
    PropertyKey,
    unknown
  >;
  const descriptors = objectGetOwnPropertyDescriptors(definition);
  for (const key of reflectOwnKeys(descriptors)) {
    const descriptor = objectGetOwnPropertyDescriptor(definition, key);
    /* v8 ignore next -- key originates from this exact own-descriptor map. */
    if (!descriptor) return invalid();
    if (key === "shape") {
      const shape = shapeSnapshots.get(schema);
      /* v8 ignore next -- inspection records every permitted object-shape accessor. */
      if (!shape) return invalid();
      const clonedShape = Object.create(null) as Record<string, z.ZodType>;
      for (const [name, child] of Object.entries(shape))
        clonedShape[name] = cloneInspectedSchema(child, shapeSnapshots, clones);
      Object.defineProperty(copiedDefinition, key, {
        value: Object.freeze(clonedShape),
        writable: false,
        enumerable: descriptor.enumerable === true,
        configurable: descriptor.configurable === true,
      });
      continue;
    }
    /* v8 ignore next -- inspection rejects every remaining definition accessor. */
    if (!("value" in descriptor)) return invalid();
    Object.defineProperty(copiedDefinition, key, {
      ...descriptor,
      value: cloneDefinitionValue(descriptor.value, shapeSnapshots, clones),
    });
  }
  const clone = z.clone(schema, copiedDefinition as never);
  clones.set(schema, clone);
  return clone;
};

const sealSchemaAuthority = (schema: z.ZodType<JsonObject>): void => {
  const objects = inspectDeclarativeSchema(schema);
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const current = objects[index]!;
    if (current instanceof RegExp) continue;
    objectFreeze(current);
  }
};

export class DestinationDescriptorError extends Error {
  public readonly code = "destination.descriptor.invalid";

  public constructor() {
    super("destination.descriptor.invalid");
    this.name = "DestinationDescriptorError";
  }
}

const invalid = (): never => {
  throw new DestinationDescriptorError();
};

const inputValue = (
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown => {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) return invalid();
  return descriptor.value;
};

const exactKeys = (
  descriptors: PropertyDescriptorMap,
  expected: readonly string[],
): boolean =>
  objectKeys(descriptors).sort().join(",") === [...expected].sort().join(",");

const descriptorInputKeysAreValid = (
  descriptors: PropertyDescriptorMap,
): boolean => {
  const required = [
    "commandName",
    "createReporter",
    "credentialSlots",
    "defaultSettings",
    "deliveryIdentitySupport",
    "descriptorVersion",
    "destinationType",
    "documentationPath",
    "settingsSchema",
    "settingsVersion",
    "transport",
  ];
  const keys = objectKeys(descriptors);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || key === "createRetriever")
  );
};

const observeUnexpectedPromise = (value: unknown): void => {
  try {
    void reflectApply(promiseThen, value, [() => undefined, () => undefined]);
  } catch {
    // Non-native thenables are outside the trusted synchronous callback seam.
  }
};

const denseArrayValues = (input: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(input) || input.length > maximum) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(input);
  const ownKeys = reflectOwnKeys(input);
  if (
    ownKeys.length !== input.length + 1 ||
    ownKeys.some((key) => typeof key !== "string")
  )
    return invalid();
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    /* v8 ignore next -- exact dense own-key cardinality proves each indexed data slot exists. */
    if (!descriptor || !("value" in descriptor)) return invalid();
    values.push(descriptor.value);
  }
  return values;
};

const parseSettingsWith = <Settings extends JsonObject>(
  schemaAuthority: CompiledSettingsSchema,
  settingKeys: ReadonlySet<string>,
  defaults: JsonObject,
  input: unknown,
): Settings => {
  try {
    const candidate = cloneJsonObject(input);
    if (settingsContainCredentialKey(candidate)) return invalid();
    if (objectKeys(candidate).some((key) => !settingKeys.has(key)))
      return invalid();
    const merged: Record<string, unknown> = Object.assign(
      Object.create(null) as Record<string, unknown>,
      defaults,
      candidate,
    );
    const result = reflectApply(
      schemaAuthority.safeParse,
      schemaAuthority.schema,
      [merged],
    ) as ReturnType<z.ZodType<Settings>["safeParse"]>;
    if (!result.success) return invalid();
    const output = cloneJsonObject(result.data);
    return output as Settings;
  } catch {
    return invalid();
  }
};

const compileStrictSchema = (
  schema: z.ZodType<JsonObject>,
): CompiledSettingsSchema => {
  const shapeSnapshots = new WeakMap<
    object,
    Readonly<Record<string, z.ZodType>>
  >();
  inspectDeclarativeSchema(schema, shapeSnapshots);
  const conversionSchema = cloneInspectedSchema(
    schema,
    shapeSnapshots,
    new WeakMap(),
  );
  const jsonSchema = z.toJSONSchema(conversionSchema) as Record<
    string,
    unknown
  >;
  if (jsonSchema.type !== "object") return invalid();
  const pending: unknown[] = [jsonSchema];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > 1_024) return invalid();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    /* v8 ignore next -- Zod's JSON Schema emitter currently returns a tree; shared nodes remain bounded. */
    if (seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.type === "object" && record.additionalProperties !== false)
      return invalid();
    for (const child of Object.values(record)) pending.push(child);
  }
  const properties = jsonSchema.properties as Record<string, unknown>;
  const enumerableJsonSchema = Object.assign(
    Object.create(null) as Record<string, unknown>,
    jsonSchema,
  );
  const detachedSchema = z.fromJSONSchema(
    cloneJsonObject(enumerableJsonSchema),
  ) as z.ZodType<JsonObject>;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured from a private detached schema and invoked with that exact receiver.
  const detachedSafeParse = detachedSchema.safeParse;
  // This graph was constructed solely from the bounded machine schema above;
  // materializing its shapes invokes no caller-owned authority.
  z.toJSONSchema(detachedSchema);
  inspectDeclarativeSchema(detachedSchema);
  void reflectApply(detachedSafeParse, detachedSchema, [Object.create(null)]);
  sealSchemaAuthority(detachedSchema);
  return Object.freeze({
    schema: detachedSchema,
    safeParse: detachedSafeParse,
    identity: cloneJsonObject(enumerableJsonSchema),
    settingKeys: Object.freeze(objectKeys(properties).sort()),
  });
};

const parseCredentialSlots = (input: unknown): readonly CredentialSlot[] => {
  try {
    const candidates = denseArrayValues(input, 16);
    const slots: CredentialSlot[] = [];
    const ids = new Set<string>();
    for (const value of candidates) {
      if (typeof value !== "object" || value === null) return invalid();
      const descriptors = objectGetOwnPropertyDescriptors(value);
      if (!exactKeys(descriptors, ["id", "required"])) return invalid();
      const id = createCredentialSlotId(inputValue(descriptors, "id"));
      const required = inputValue(descriptors, "required");
      if (typeof required !== "boolean" || ids.has(id)) return invalid();
      ids.add(id);
      slots.push(Object.freeze({ id, required }));
    }
    return Object.freeze(slots);
  } catch {
    return invalid();
  }
};

const parseDocumentationPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^\/docs\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(value)
  )
    return invalid();
  return value;
};

export const isDestinationDescriptor = (
  value: unknown,
): value is DestinationDescriptor =>
  typeof value === "object" && value !== null && descriptorRegistry.has(value);

export const defineDestinationDescriptor = <Settings extends JsonObject>(
  input: DestinationDescriptorInput<Settings>,
): DestinationDescriptor<Settings> => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (!descriptorInputKeysAreValid(descriptors)) return invalid();
    if (inputValue(descriptors, "descriptorVersion") !== 1) return invalid();
    const settingsVersion = inputValue(descriptors, "settingsVersion");
    if (
      !Number.isSafeInteger(settingsVersion) ||
      (settingsVersion as number) < 1 ||
      (settingsVersion as number) > 65_535
    )
      return invalid();
    const schema = inputValue(
      descriptors,
      "settingsSchema",
    ) as z.ZodType<Settings>;
    if (!(schema instanceof z.ZodType)) return invalid();
    const rawDefaults = cloneJsonObject(
      inputValue(descriptors, "defaultSettings"),
    );
    const schemaAuthority = compileStrictSchema(schema);
    const settingKeys = schemaAuthority.settingKeys;
    const settingKeySet = new Set(settingKeys);
    const defaults = parseSettingsWith(
      schemaAuthority,
      settingKeySet,
      rawDefaults,
      rawDefaults,
    );
    const slots = parseCredentialSlots(
      inputValue(descriptors, "credentialSlots"),
    );
    const deliveryIdentitySupport = inputValue(
      descriptors,
      "deliveryIdentitySupport",
    );
    if (
      deliveryIdentitySupport !== "native-idempotency" &&
      deliveryIdentitySupport !== "duplicates-possible"
    )
      return invalid();
    const transportInput = inputValue(descriptors, "transport");
    if (typeof transportInput !== "object" || transportInput === null)
      return invalid();
    const transportDescriptors =
      objectGetOwnPropertyDescriptors(transportInput);
    const kind = inputValue(transportDescriptors, "kind");
    let transport: DestinationTransportDeclaration;
    let resolveEndpoint:
      ((settings: JsonObject) => RemoteEndpointCandidate) | undefined;
    if (kind === "local" && exactKeys(transportDescriptors, ["kind"])) {
      transport = Object.freeze({ kind });
    } else if (
      kind === "remote" &&
      exactKeys(transportDescriptors, ["kind", "resolveEndpoint"])
    ) {
      const resolver = inputValue(transportDescriptors, "resolveEndpoint");
      if (typeof resolver !== "function") return invalid();
      resolveEndpoint = resolver as (
        settings: JsonObject,
      ) => RemoteEndpointCandidate;
      transport = Object.freeze({ kind });
    } else return invalid();
    const factory = inputValue(descriptors, "createReporter");
    if (typeof factory !== "function") return invalid();
    const retrieverFactory = descriptors.createRetriever
      ? inputValue(descriptors, "createRetriever")
      : undefined;
    if (
      retrieverFactory !== undefined &&
      typeof retrieverFactory !== "function"
    )
      return invalid();

    const descriptor = Object.freeze({
      descriptorVersion: 1 as const,
      destinationType: createDestinationTypeId(
        inputValue(descriptors, "destinationType"),
      ),
      commandName: createDestinationCommandName(
        inputValue(descriptors, "commandName"),
      ),
      settingsVersion: settingsVersion as number,
      settingKeys,
      defaultSettings: defaults,
      credentialSlots: slots,
      documentationPath: parseDocumentationPath(
        inputValue(descriptors, "documentationPath"),
      ),
      deliveryIdentitySupport,
      retrievalSupport:
        retrieverFactory === undefined ? "unsupported" : "search-and-get",
      transport,
    }) as DestinationDescriptor<Settings>;
    descriptorRegistry.set(descriptor, {
      schemaAuthority,
      settingKeys: settingKeySet,
      ...(resolveEndpoint ? { resolveEndpoint } : {}),
      createReporter: factory as (
        context: ReporterFactoryContext<JsonObject>,
      ) => Reporter,
      ...(retrieverFactory === undefined
        ? {}
        : {
            createRetriever: retrieverFactory as (
              context: RetrieverFactoryContext<JsonObject>,
            ) => Retriever,
          }),
    });
    return descriptor;
  } catch {
    return invalid();
  }
};

export const parseDestinationSettings = <Settings extends JsonObject>(
  descriptor: DestinationDescriptor<Settings>,
  input: unknown,
): Settings => {
  const stored = descriptorRegistry.get(descriptor);
  if (!stored) return invalid();
  return parseSettingsWith(
    stored.schemaAuthority,
    stored.settingKeys,
    descriptor.defaultSettings,
    input,
  );
};

export type ResolveDestinationConnectionInput = Readonly<{
  connectionId: DestinationConnectionId;
  settings: unknown;
}>;

declare const preparedDestinationConnectionBrand: unique symbol;
export type PreparedDestinationConnection = Readonly<{
  connectionId: DestinationConnectionId;
  endpoint: ValidatedDestinationEndpoint | null;
  readonly [preparedDestinationConnectionBrand]: true;
}>;

type StoredPreparedConnection = Readonly<{
  descriptor: DestinationDescriptor;
  storedDescriptor: StoredDescriptor;
  settings: JsonObject;
}>;

const preparedConnectionRegistry = new WeakMap<
  object,
  StoredPreparedConnection
>();

export type PrepareDestinationCapabilityInput = Readonly<{
  credentials: unknown;
  transport: BoundDestinationTransport | null;
}>;
export type PrepareReporterInput = PrepareDestinationCapabilityInput;
export type PrepareRetrieverInput = PrepareDestinationCapabilityInput;

const resolveRemoteEndpoint = (
  resolver: (settings: JsonObject) => RemoteEndpointCandidate,
  settings: JsonObject,
): ValidatedDestinationEndpoint => {
  const candidate = resolver(settings);
  if (candidate instanceof Promise) {
    observeUnexpectedPromise(candidate);
    return invalid();
  }
  if (typeof candidate !== "object" || candidate === null) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(candidate);
  if (!exactKeys(descriptors, ["allowInsecureLoopback", "url"]))
    return invalid();
  const allowInsecureLoopback = inputValue(
    descriptors,
    "allowInsecureLoopback",
  );
  if (typeof allowInsecureLoopback !== "boolean") return invalid();
  return validateDestinationEndpoint(inputValue(descriptors, "url"), {
    allowInsecureLoopback,
  });
};

export const resolveDestinationConnection = <Settings extends JsonObject>(
  descriptor: DestinationDescriptor<Settings>,
  input: ResolveDestinationConnectionInput,
): PreparedDestinationConnection => {
  try {
    const stored = descriptorRegistry.get(descriptor);
    if (!stored || typeof input !== "object" || input === null)
      return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    if (!exactKeys(descriptors, ["connectionId", "settings"])) return invalid();
    const connectionId = createDestinationConnectionId(
      inputValue(descriptors, "connectionId"),
    );
    const settings = parseDestinationSettings(
      descriptor,
      inputValue(descriptors, "settings"),
    );
    let endpoint: ValidatedDestinationEndpoint | null = null;
    if (descriptor.transport.kind === "remote") {
      /* v8 ignore next -- descriptor compilation binds every remote declaration to one resolver. */
      if (!stored.resolveEndpoint) return invalid();
      endpoint = resolveRemoteEndpoint(stored.resolveEndpoint, settings);
    }
    const prepared = Object.freeze({
      connectionId,
      endpoint,
    }) as PreparedDestinationConnection;
    preparedConnectionRegistry.set(prepared, {
      descriptor,
      storedDescriptor: stored,
      settings,
    });
    return prepared;
  } catch {
    return invalid();
  }
};

const prepareCapabilityContext = (
  prepared: PreparedDestinationConnection,
  input: PrepareDestinationCapabilityInput,
): Readonly<{
  stored: StoredPreparedConnection;
  context: ReporterFactoryContext<JsonObject>;
}> => {
  const stored = preparedConnectionRegistry.get(prepared);
  if (!stored || typeof input !== "object" || input === null) return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(input);
  if (!exactKeys(descriptors, ["credentials", "transport"])) return invalid();
  const transportInput = inputValue(descriptors, "transport");
  let transport: BoundDestinationTransport | null = null;
  if (prepared.endpoint) {
    if (!isBoundDestinationTransport(transportInput)) return invalid();
    if (transportInput.endpoint !== prepared.endpoint) return invalid();
    transport = transportInput;
  } else if (transportInput !== null) return invalid();
  const credentials = createReporterCredentialAccessor(
    stored.descriptor.credentialSlots,
    inputValue(descriptors, "credentials"),
    prepared.endpoint?.origin ?? null,
  );
  return Object.freeze({
    stored,
    context: Object.freeze({
      connectionId: prepared.connectionId,
      settings: stored.settings,
      credentials,
      endpoint: prepared.endpoint,
      transport,
    }),
  });
};

export const prepareDestinationReporter = (
  prepared: PreparedDestinationConnection,
  input: PrepareReporterInput,
): Reporter => {
  try {
    const preparedCapability = prepareCapabilityContext(prepared, input);
    const reporter = preparedCapability.stored.storedDescriptor.createReporter(
      preparedCapability.context,
    );
    if (!isRegisteredDestinationReporter(reporter)) {
      observeUnexpectedPromise(reporter);
      return invalid();
    }
    return reporter;
  } catch {
    return invalid();
  }
};

export const prepareDestinationRetriever = (
  prepared: PreparedDestinationConnection,
  input: PrepareRetrieverInput,
): Retriever => {
  try {
    const stored = preparedConnectionRegistry.get(prepared);
    if (!stored?.storedDescriptor.createRetriever) return invalid();
    const preparedCapability = prepareCapabilityContext(prepared, input);
    const factory = preparedCapability.stored.storedDescriptor.createRetriever;
    /* v8 ignore next -- the same immutable stored descriptor was checked before credential binding. */
    if (!factory) return invalid();
    const retriever = factory(preparedCapability.context);
    if (!isRegisteredDestinationRetriever(retriever)) {
      observeUnexpectedPromise(retriever);
      return invalid();
    }
    return retriever;
  } catch {
    return invalid();
  }
};

declare const destinationRegistryBrand: unique symbol;
export type DestinationRegistry = Readonly<{
  descriptors: readonly DestinationDescriptor[];
  readonly [destinationRegistryBrand]: true;
}>;

const compiledRegistries = new WeakMap<
  object,
  ReadonlyMap<string, DestinationDescriptor>
>();

export const compileDestinationRegistry = (
  descriptors: readonly DestinationDescriptor[],
): DestinationRegistry => {
  try {
    const candidates = denseArrayValues(descriptors, 32);
    const byKey = new Map<string, DestinationDescriptor>();
    const commandNames = new Set<string>();
    const copy: DestinationDescriptor[] = [];
    for (const descriptor of candidates) {
      if (
        !isDestinationDescriptor(descriptor) ||
        byKey.has(descriptor.destinationType) ||
        commandNames.has(descriptor.commandName)
      )
        return invalid();
      byKey.set(descriptor.destinationType, descriptor);
      commandNames.add(descriptor.commandName);
      copy.push(descriptor);
    }
    copy.sort((left, right) =>
      left.destinationType < right.destinationType ? -1 : 1,
    );
    const registry = Object.freeze({
      descriptors: Object.freeze(copy),
    }) as DestinationRegistry;
    compiledRegistries.set(registry, byKey);
    return registry;
  } catch {
    return invalid();
  }
};

export const getDestinationDescriptor = (
  registry: DestinationRegistry,
  destinationType: unknown,
): DestinationDescriptor | undefined => {
  const compiled = compiledRegistries.get(registry);
  if (!compiled) return invalid();
  try {
    return compiled.get(createDestinationTypeId(destinationType));
  } catch {
    return undefined;
  }
};
