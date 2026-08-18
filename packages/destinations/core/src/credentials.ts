import type { CredentialSlotId } from "./identity.js";

export type CredentialSlot = Readonly<{
  id: CredentialSlotId;
  required: boolean;
}>;

declare const credentialAccessorBrand: unique symbol;

export type ReporterCredentialAccessor = Readonly<{
  readonly [credentialAccessorBrand]: true;
}>;

type StoredCredentials = Readonly<{
  origin: string | null;
  slots: ReadonlyMap<CredentialSlotId, string | undefined>;
}>;

const credentialRegistry = new WeakMap<object, StoredCredentials>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectKeys = Object.keys;

export class DestinationCredentialError extends Error {
  public readonly code = "destination.credential.invalid";

  public constructor() {
    super("destination.credential.invalid");
    this.name = "DestinationCredentialError";
  }
}

const invalid = (): never => {
  throw new DestinationCredentialError();
};

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const validSecret = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8_192 &&
  !value.includes("\0") &&
  !hasLoneSurrogate(value);

export const createReporterCredentialAccessor = (
  slots: readonly CredentialSlot[],
  input: unknown,
  origin: string | null,
): ReporterCredentialAccessor => {
  if (
    typeof input !== "object" ||
    input === null ||
    (objectGetPrototypeOf(input) !== Object.prototype &&
      objectGetPrototypeOf(input) !== null)
  )
    return invalid();
  const descriptors = objectGetOwnPropertyDescriptors(input);
  const inputKeys = objectKeys(descriptors).sort();
  const expectedKeys = slots.map((slot) => slot.id).sort();
  if (inputKeys.some((key) => !expectedKeys.includes(key as CredentialSlotId)))
    return invalid();

  const values = new Map<CredentialSlotId, string | undefined>();
  for (const slot of slots) {
    const descriptor = descriptors[slot.id];
    if (!descriptor) {
      if (slot.required) return invalid();
      values.set(slot.id, undefined);
      continue;
    }
    if (!("value" in descriptor) || !validSecret(descriptor.value))
      return invalid();
    values.set(slot.id, descriptor.value);
  }
  const accessor = Object.freeze(
    Object.create(null),
  ) as ReporterCredentialAccessor;
  credentialRegistry.set(accessor, Object.freeze({ origin, slots: values }));
  return accessor;
};

export const isReporterCredentialAccessor = (
  value: unknown,
): value is ReporterCredentialAccessor =>
  typeof value === "object" && value !== null && credentialRegistry.has(value);

export const readReporterCredential = (
  accessor: ReporterCredentialAccessor,
  slot: CredentialSlotId,
): string | undefined => {
  const stored = credentialRegistry.get(accessor);
  if (!stored || !stored.slots.has(slot)) return invalid();
  return stored.slots.get(slot);
};

export const credentialAccessorMatchesOrigin = (
  accessor: ReporterCredentialAccessor,
  origin: string | null,
): boolean => credentialRegistry.get(accessor)?.origin === origin;
