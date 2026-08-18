export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const DESTINATION_SETTINGS_LIMITS = Object.freeze({
  maximumArrayItems: 256,
  maximumDepth: 16,
  maximumNodes: 1_024,
  maximumObjectKeys: 64,
  maximumStringUtf8Bytes: 8_192,
  maximumTotalUtf8Bytes: 32_768,
});

const textEncoder = new TextEncoder();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf: (value: object) => object | null =
  Object.getPrototypeOf;
const objectKeys = Object.keys;

const plainPrototype = (value: object): boolean => {
  const prototype = objectGetPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export class DestinationDataError extends Error {
  public readonly code = "destination.data.invalid";

  public constructor() {
    super("destination.data.invalid");
    this.name = "DestinationDataError";
  }
}

const invalid = (): never => {
  throw new DestinationDataError();
};

const safeString = (
  value: string,
  account: (bytes: number) => void,
): string => {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > DESTINATION_SETTINGS_LIMITS.maximumStringUtf8Bytes) invalid();
  account(bytes);
  return value;
};

export const cloneJsonObject = (input: unknown): JsonObject => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let totalUtf8Bytes = 0;
  const account = (bytes: number): void => {
    totalUtf8Bytes += bytes;
    if (totalUtf8Bytes > DESTINATION_SETTINGS_LIMITS.maximumTotalUtf8Bytes)
      invalid();
  };

  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (
      nodes > DESTINATION_SETTINGS_LIMITS.maximumNodes ||
      depth > DESTINATION_SETTINGS_LIMITS.maximumDepth
    )
      invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (typeof value === "string") return safeString(value, account);
    if (typeof value !== "object" || seen.has(value)) return invalid();
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > DESTINATION_SETTINGS_LIMITS.maximumArrayItems)
        invalid();
      const descriptors = objectGetOwnPropertyDescriptors(value);
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) invalid();
        output.push(
          visit(
            (descriptor as PropertyDescriptor & { value: unknown }).value,
            depth + 1,
          ),
        );
      }
      for (const key of objectKeys(descriptors)) {
        if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)) invalid();
      }
      return Object.freeze(output);
    }

    if (!plainPrototype(value)) invalid();
    const descriptors = objectGetOwnPropertyDescriptors(value);
    const keys = objectKeys(descriptors);
    if (keys.length > DESTINATION_SETTINGS_LIMITS.maximumObjectKeys) invalid();
    const output: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) invalid();
      safeString(key, account);
      output[key] = visit(
        (descriptor as PropertyDescriptor & { value: unknown }).value,
        depth + 1,
      );
    }
    return Object.freeze(output);
  };

  const cloned = visit(input, 0);
  if (Array.isArray(cloned) || cloned === null || typeof cloned !== "object")
    invalid();
  return cloned as JsonObject;
};

const credentialKeyPattern =
  /(?:api[-_.]?key|auth(?:orization)?|credential|password|private[-_.]?key|secret|token)/iu;

export const settingsContainCredentialKey = (value: JsonValue): boolean => {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current as readonly JsonValue[]) pending.push(child);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (credentialKeyPattern.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
};
