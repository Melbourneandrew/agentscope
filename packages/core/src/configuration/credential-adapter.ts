import { createHash } from "node:crypto";

import {
  createCredentialSlotId,
  createDestinationConnectionId,
  createDestinationTypeId,
  type CredentialSlotId,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "@agentscope/destinations-core/configuration";

import type { ConfigurationCredentialReference } from "./schema.js";

export const CREDENTIAL_RESOLUTION_FAILURES = Object.freeze([
  "unavailable",
  "locked",
  "denied",
  "missing",
  "malformed",
] as const);
export type CredentialResolutionFailure =
  (typeof CREDENTIAL_RESOLUTION_FAILURES)[number];

export type CredentialOwnership = Readonly<{
  destinationType: DestinationTypeId;
  connectionId: DestinationConnectionId;
  slot: CredentialSlotId;
}>;

export type CredentialResolutionContext = Readonly<{
  context: "interactive" | "hook-equivalent" | "hook";
  signal: AbortSignal;
}>;

export type ResolvedCredential = Readonly<{
  readonly resolvedCredential: "agentscope-core";
}>;

export type CredentialResolutionResult =
  | Readonly<{ ok: true; credential: ResolvedCredential }>
  | Readonly<{ ok: false; code: CredentialResolutionFailure }>;

export type StoredCredentialBackend =
  "macos-keychain" | "windows-credential-manager" | "linux-secret-service";
export type CredentialBackend = StoredCredentialBackend | "ci-environment";
export type StoredConfigurationCredentialReference = Extract<
  ConfigurationCredentialReference,
  { backend: StoredCredentialBackend }
>;

export type StoredCredentialBackendImplementation = Readonly<{
  createPending(
    input: Readonly<{
      ownership: CredentialOwnership;
      generationId: string;
      secret: string;
      signal: AbortSignal;
    }>,
  ): Promise<
    | Readonly<{ ok: true; referenceId: string }>
    | Readonly<{ ok: false; code: CredentialResolutionFailure }>
  >;
  resolve(
    input: Readonly<{
      reference: ConfigurationCredentialReference;
      context: CredentialResolutionContext;
    }>,
  ): Promise<
    | Readonly<{ ok: true; secret: string }>
    | Readonly<{ ok: false; code: CredentialResolutionFailure }>
  >;
  activate(
    input: Readonly<{
      reference: ConfigurationCredentialReference;
      signal: AbortSignal;
    }>,
  ): Promise<boolean>;
  removePending(
    input: Readonly<{
      reference: ConfigurationCredentialReference;
      signal: AbortSignal;
    }>,
  ): Promise<boolean>;
  removeOwned(
    input: Readonly<{
      ownership: CredentialOwnership;
      reference: ConfigurationCredentialReference;
      signal: AbortSignal;
    }>,
  ): Promise<boolean>;
}>;

export type CredentialBackendAdapter = Readonly<{
  readonly credentialBackendAdapter: "agentscope-core";
}>;

export type CredentialBackendRegistry = Readonly<{
  readonly credentialBackendRegistry: "agentscope-core";
}>;

type StoredAdapter = Readonly<{
  backend: CredentialBackend;
  implementation?: StoredCredentialBackendImplementation;
  environment?: object;
}>;

const adapters = new WeakMap<object, StoredAdapter>();
const ownerships = new WeakSet<object>();
const resolutionContexts = new WeakSet<object>();
const registries = new WeakMap<
  object,
  ReadonlyMap<CredentialBackend, CredentialBackendAdapter>
>();
const resolvedCredentials = new WeakMap<object, string>();
const referenceIdPattern = /^credential-reference-v1-[0-9a-f]{64}$/u;
const generationIdPattern = /^credential-generation-v1-[0-9a-f]{64}$/u;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const storedBackends = new Set<StoredCredentialBackend>([
  "macos-keychain",
  "windows-credential-manager",
  "linux-secret-service",
]);

export class CredentialAdapterError extends Error {
  public readonly code = "core.credential.invalid";

  public constructor() {
    super("core.credential.invalid");
    this.name = "CredentialAdapterError";
  }
}

const invalid = (): never => {
  throw new CredentialAdapterError();
};

const dataValue = (descriptor: PropertyDescriptor): unknown =>
  (descriptor as PropertyDescriptor & { value: unknown }).value;

const exactDataRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return invalid();
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    const capturedPrototype: unknown = Object.getPrototypeOf(value);
    prototype = capturedPrototype as object | null;
    const captured: unknown = Object.getOwnPropertyDescriptors(value);
    descriptors = captured as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        dataValue(descriptor),
      ]),
    ),
  );
};

const exactReference = (value: unknown): ConfigurationCredentialReference => {
  if (typeof value !== "object" || value === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const data = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  );
  if (
    data.referenceVersion !== 1 ||
    typeof data.generationId !== "string" ||
    !generationIdPattern.test(data.generationId)
  )
    return invalid();
  if (
    data.backend === "ci-environment" &&
    Object.keys(data).sort().join(",") ===
      "backend,environmentVariable,generationId,referenceVersion" &&
    typeof data.environmentVariable === "string" &&
    environmentNamePattern.test(data.environmentVariable)
  )
    return Object.freeze(data) as ConfigurationCredentialReference;
  if (
    storedBackends.has(data.backend as StoredCredentialBackend) &&
    Object.keys(data).sort().join(",") ===
      "backend,generationId,referenceId,referenceVersion" &&
    typeof data.referenceId === "string" &&
    referenceIdPattern.test(data.referenceId)
  )
    return Object.freeze(data) as ConfigurationCredentialReference;
  return invalid();
};

const validSecret = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.includes("\0")
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

export const createCredentialOwnership = (input: {
  destinationType: unknown;
  connectionId: unknown;
  slot: unknown;
}): CredentialOwnership => {
  try {
    const data = exactDataRecord(input, [
      "destinationType",
      "connectionId",
      "slot",
    ]);
    const ownership = Object.freeze({
      destinationType: createDestinationTypeId(data.destinationType),
      connectionId: createDestinationConnectionId(data.connectionId),
      slot: createCredentialSlotId(data.slot),
    });
    ownerships.add(ownership);
    return ownership;
  } catch {
    return invalid();
  }
};

export const isCredentialOwnership = (
  value: unknown,
): value is CredentialOwnership =>
  typeof value === "object" && value !== null && ownerships.has(value);

export const createCredentialResolutionContext = (
  context: CredentialResolutionContext["context"],
  signal: AbortSignal,
): CredentialResolutionContext => {
  if (
    !["interactive", "hook-equivalent", "hook"].includes(context) ||
    !(signal instanceof AbortSignal)
  )
    return invalid();
  const value = Object.freeze({ context, signal });
  resolutionContexts.add(value);
  return value;
};

export const isCredentialResolutionContext = (
  value: unknown,
): value is CredentialResolutionContext =>
  typeof value === "object" && value !== null && resolutionContexts.has(value);

const validateImplementation = (
  value: unknown,
): StoredCredentialBackendImplementation => {
  const data = exactDataRecord(value, [
    "activate",
    "createPending",
    "removeOwned",
    "removePending",
    "resolve",
  ]);
  if (Object.values(data).some((candidate) => typeof candidate !== "function"))
    return invalid();
  return value as StoredCredentialBackendImplementation;
};

export const defineStoredCredentialBackendAdapter = (
  backend: StoredCredentialBackend,
  implementation: StoredCredentialBackendImplementation,
): CredentialBackendAdapter => {
  if (!storedBackends.has(backend)) return invalid();
  const adapter = Object.freeze({
    credentialBackendAdapter: "agentscope-core" as const,
  });
  adapters.set(adapter, {
    backend,
    implementation: validateImplementation(implementation),
  });
  return adapter;
};

export const createCiEnvironmentCredentialAdapter = (
  environment: unknown,
): CredentialBackendAdapter => {
  if (typeof environment !== "object" || environment === null) return invalid();
  const adapter = Object.freeze({
    credentialBackendAdapter: "agentscope-core" as const,
  });
  adapters.set(adapter, {
    backend: "ci-environment",
    environment,
  });
  return adapter;
};

export const compileCredentialBackendRegistry = (
  input: readonly CredentialBackendAdapter[],
): CredentialBackendRegistry => {
  if (!Array.isArray(input) || input.length > 4) return invalid();
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    return invalid();
  const byBackend = new Map<CredentialBackend, CredentialBackendAdapter>();
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    /* v8 ignore next -- exact dense own-key inventory above guarantees an indexed data descriptor. */
    if (!descriptor || !("value" in descriptor)) return invalid();
    const adapter = descriptor.value as CredentialBackendAdapter;
    const stored = adapters.get(adapter);
    if (!stored || byBackend.has(stored.backend)) return invalid();
    byBackend.set(stored.backend, adapter);
  }
  const registry = Object.freeze({
    credentialBackendRegistry: "agentscope-core" as const,
  });
  registries.set(registry, byBackend);
  return registry;
};

export const isCredentialBackendRegistry = (
  value: unknown,
): value is CredentialBackendRegistry =>
  typeof value === "object" && value !== null && registries.has(value);

const storedAdapter = (
  registry: CredentialBackendRegistry,
  backend: CredentialBackend,
): StoredAdapter => {
  const adapter = registries.get(registry)?.get(backend);
  const stored = adapter ? adapters.get(adapter) : undefined;
  return stored ?? invalid();
};

const resolutionFailure = (
  value: unknown,
): CredentialResolutionFailure | undefined =>
  CREDENTIAL_RESOLUTION_FAILURES.includes(value as CredentialResolutionFailure)
    ? (value as CredentialResolutionFailure)
    : undefined;

const resolved = (secret: string): CredentialResolutionResult => {
  if (!validSecret(secret))
    return Object.freeze({ ok: false, code: "malformed" });
  const credential = Object.freeze({
    resolvedCredential: "agentscope-core" as const,
  });
  resolvedCredentials.set(credential, secret);
  return Object.freeze({ ok: true, credential });
};

const failed = (
  code: CredentialResolutionFailure,
): CredentialResolutionResult => Object.freeze({ ok: false, code });

const ciResolution = (
  stored: StoredAdapter,
  reference: ConfigurationCredentialReference,
): CredentialResolutionResult => {
  /* v8 ignore next 5 -- exact reference parsing and backend-keyed registry dispatch establish this pair. */
  if (
    reference.backend !== "ci-environment" ||
    !environmentNamePattern.test(reference.environmentVariable)
  )
    return failed("malformed");
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(
      stored.environment,
      reference.environmentVariable,
    );
  } catch {
    return failed("unavailable");
  }
  if (!descriptor) return failed("missing");
  if (!("value" in descriptor)) return failed("denied");
  const value: unknown = descriptor.value;
  return value === undefined
    ? failed("missing")
    : typeof value === "string"
      ? resolved(value)
      : failed("malformed");
};

const storedResolution = async (
  stored: StoredAdapter,
  reference: ConfigurationCredentialReference,
  context: CredentialResolutionContext,
): Promise<CredentialResolutionResult> => {
  /* v8 ignore next 6 -- exact reference parsing and backend-keyed registry dispatch establish stored identity syntax. */
  if (
    reference.backend === "ci-environment" ||
    !referenceIdPattern.test(reference.referenceId) ||
    !generationIdPattern.test(reference.generationId)
  )
    return failed("malformed");
  try {
    const result = await stored.implementation?.resolve({
      reference,
      context,
    });
    if (!result || typeof result !== "object") return failed("malformed");
    const data = exactDataRecord(
      result,
      "ok" in result && result.ok === true ? ["ok", "secret"] : ["code", "ok"],
    );
    if (data.ok === true) return resolved(data.secret as string);
    const code = resolutionFailure(data.code);
    return failed(code ?? "malformed");
  } catch {
    return failed("unavailable");
  }
};

export const resolveCredentialReference = async (
  registry: CredentialBackendRegistry,
  reference: ConfigurationCredentialReference,
  context: CredentialResolutionContext,
): Promise<CredentialResolutionResult> => {
  if (!isCredentialResolutionContext(context)) return invalid();
  const validatedReference = exactReference(reference);
  const stored = storedAdapter(registry, validatedReference.backend);
  if (context.signal.aborted) return failed("unavailable");
  return stored.backend === "ci-environment"
    ? ciResolution(stored, validatedReference)
    : storedResolution(stored, validatedReference, context);
};

export const isResolvedCredential = (
  value: unknown,
): value is ResolvedCredential =>
  typeof value === "object" && value !== null && resolvedCredentials.has(value);

export const readResolvedCredentialForCore = (
  credential: ResolvedCredential,
): string => resolvedCredentials.get(credential) ?? invalid();

export const getStoredCredentialImplementation = (
  registry: CredentialBackendRegistry,
  backend: StoredCredentialBackend,
): StoredCredentialBackendImplementation =>
  storedAdapter(registry, backend)
    .implementation as StoredCredentialBackendImplementation;

export const createStoredCredentialReference = (
  backend: StoredCredentialBackend,
  referenceId: unknown,
  generationId: unknown,
): ConfigurationCredentialReference => {
  if (
    !storedBackends.has(backend) ||
    typeof referenceId !== "string" ||
    !referenceIdPattern.test(referenceId) ||
    typeof generationId !== "string" ||
    !generationIdPattern.test(generationId)
  )
    return invalid();
  return Object.freeze({
    referenceVersion: 1 as const,
    backend,
    referenceId,
    generationId,
  });
};

export const deriveStoredCredentialReference = (
  backend: StoredCredentialBackend,
  ownership: CredentialOwnership,
  generationId: string,
): StoredConfigurationCredentialReference => {
  if (
    !storedBackends.has(backend) ||
    !isCredentialOwnership(ownership) ||
    !generationIdPattern.test(generationId)
  )
    return invalid();
  const referenceId = `${"credential-reference-v1-"}${createHash("sha256")
    .update(ownership.destinationType)
    .update("\0")
    .update(ownership.connectionId)
    .update("\0")
    .update(ownership.slot)
    .update("\0")
    .update(generationId)
    .digest("hex")}`;
  return createStoredCredentialReference(
    backend,
    referenceId,
    generationId,
  ) as StoredConfigurationCredentialReference;
};

export const createCiEnvironmentCredentialReference = (
  environmentVariable: unknown,
  generationId: unknown,
): ConfigurationCredentialReference => {
  if (
    typeof environmentVariable !== "string" ||
    !environmentNamePattern.test(environmentVariable) ||
    typeof generationId !== "string" ||
    !generationIdPattern.test(generationId)
  )
    return invalid();
  return Object.freeze({
    referenceVersion: 1 as const,
    backend: "ci-environment" as const,
    environmentVariable,
    generationId,
  });
};
