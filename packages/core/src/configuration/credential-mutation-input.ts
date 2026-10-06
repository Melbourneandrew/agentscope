import {
  isCredentialOwnership,
  isCredentialResolutionContext,
  type CredentialOwnership,
  type CredentialResolutionContext,
  type StoredCredentialBackend,
} from "./credential-adapter.js";
import {
  isConfigurationStore,
  isConfigurationProcessIdentity,
  type ConfigurationStore,
  type ConfigurationProcessIdentity,
} from "./transaction.js";
import { CredentialLifecycleError } from "./credential-reference-evidence.js";
import type {
  AgentscopeConfigurationSnapshot,
  ConfigurationCredentialReference,
} from "./schema.js";

export type CredentialConfigurationRequest =
  | Readonly<{
      kind: "stored";
      backend: StoredCredentialBackend;
      secret: string;
    }>
  | Readonly<{
      kind: "ci-environment";
      environmentVariable: string;
    }>;

export type ConfigureCredentialInput = Readonly<{
  store: ConfigurationStore;
  owner: ConfigurationProcessIdentity;
  expectedGeneration: number | null;
  ownership: CredentialOwnership;
  request: CredentialConfigurationRequest;
  resolutionContext: CredentialResolutionContext;
  createCandidate: (
    reference: ConfigurationCredentialReference,
  ) => AgentscopeConfigurationSnapshot;
}>;

export type RemoveCredentialInput = Readonly<{
  store: ConfigurationStore;
  owner: ConfigurationProcessIdentity;
  expectedGeneration: number;
  ownership: CredentialOwnership;
  reference: ConfigurationCredentialReference;
  resolutionContext: CredentialResolutionContext;
  createCandidate: () => AgentscopeConfigurationSnapshot;
}>;

const invalid = (): never => {
  throw new CredentialLifecycleError();
};
const dataValue = (descriptor: PropertyDescriptor): unknown =>
  (descriptor as PropertyDescriptor & { value: unknown }).value;

export const exactRequest = (
  request: CredentialConfigurationRequest,
): CredentialConfigurationRequest => {
  if (typeof request !== "object" || request === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(request);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  if (
    descriptors.kind?.value === "stored" &&
    Object.keys(descriptors).sort().join(",") === "backend,kind,secret" &&
    typeof descriptors.secret?.value === "string" &&
    descriptors.secret.value.length > 0 &&
    descriptors.secret.value.length <= 8_192 &&
    !descriptors.secret.value.includes("\0") &&
    !containsLoneSurrogate(descriptors.secret.value) &&
    [
      "macos-keychain",
      "windows-credential-manager",
      "linux-secret-service",
    ].includes(descriptors.backend?.value as string)
  )
    return Object.freeze({
      kind: "stored" as const,
      backend: descriptors.backend?.value as StoredCredentialBackend,
      secret: descriptors.secret.value,
    });
  if (
    descriptors.kind?.value === "ci-environment" &&
    Object.keys(descriptors).sort().join(",") === "environmentVariable,kind" &&
    typeof descriptors.environmentVariable?.value === "string"
  )
    return Object.freeze({
      kind: "ci-environment" as const,
      environmentVariable: descriptors.environmentVariable.value,
    });
  return invalid();
};

const containsLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

export const exactInput = (
  input: ConfigureCredentialInput,
): ConfigureCredentialInput => {
  if (typeof input !== "object" || input === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !==
      "createCandidate,expectedGeneration,owner,ownership,request,resolutionContext,store" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const values = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  ) as unknown as ConfigureCredentialInput;
  if (
    !isConfigurationStore(values.store) ||
    !isConfigurationProcessIdentity(values.owner) ||
    !isCredentialOwnership(values.ownership) ||
    !isCredentialResolutionContext(values.resolutionContext) ||
    typeof values.createCandidate !== "function" ||
    (values.expectedGeneration !== null &&
      (!Number.isSafeInteger(values.expectedGeneration) ||
        values.expectedGeneration < 0))
  )
    return invalid();
  return Object.freeze(values);
};

export const exactRemovalInput = (
  input: RemoveCredentialInput,
): RemoveCredentialInput => {
  if (typeof input !== "object" || input === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !==
      "createCandidate,expectedGeneration,owner,ownership,reference,resolutionContext,store" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const value = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      dataValue(descriptor),
    ]),
  ) as unknown as RemoveCredentialInput;
  if (
    !isConfigurationStore(value.store) ||
    !isConfigurationProcessIdentity(value.owner) ||
    !isCredentialOwnership(value.ownership) ||
    !isCredentialResolutionContext(value.resolutionContext) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    value.expectedGeneration < 0 ||
    typeof value.reference !== "object" ||
    value.reference === null ||
    typeof value.createCandidate !== "function"
  )
    return invalid();
  return Object.freeze(value);
};
