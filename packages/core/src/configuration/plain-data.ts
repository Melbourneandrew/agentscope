import type { JsonObject, JsonValue } from "@agentscope/destinations-core";

const MAXIMUM_ARRAY_ITEMS = 512;
const MAXIMUM_DEPTH = 24;
const MAXIMUM_NODES = 16_384;
const MAXIMUM_OBJECT_KEYS = 256;
const MAXIMUM_STRING_BYTES = 32_768;
const MAXIMUM_TOTAL_BYTES = 1_048_576;
const textEncoder = new TextEncoder();
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getPrototypeOf: (value: object) => object | null = Object.getPrototypeOf;
const objectKeys = Object.keys;

export const cloneConfigurationDocument = (input: unknown): JsonObject => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const account = (value: string): string => {
    const length = textEncoder.encode(value).byteLength;
    bytes += length;
    if (length > MAXIMUM_STRING_BYTES || bytes > MAXIMUM_TOTAL_BYTES)
      throw new TypeError("configuration-data-invalid");
    return value;
  };
  const visit = (value: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAXIMUM_NODES || depth > MAXIMUM_DEPTH)
      throw new TypeError("configuration-data-invalid");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new TypeError("configuration-data-invalid");
      return value;
    }
    if (typeof value === "string") return account(value);
    if (typeof value !== "object" || seen.has(value))
      throw new TypeError("configuration-data-invalid");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAXIMUM_ARRAY_ITEMS)
        throw new TypeError("configuration-data-invalid");
      const descriptors = getOwnPropertyDescriptors(value);
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor))
          throw new TypeError("configuration-data-invalid");
        output.push(visit(descriptor.value, depth + 1));
      }
      if (
        objectKeys(descriptors).some(
          (key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key),
        )
      )
        throw new TypeError("configuration-data-invalid");
      return Object.freeze(output);
    }
    const prototype = getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("configuration-data-invalid");
    const descriptors = getOwnPropertyDescriptors(value);
    const keys = objectKeys(descriptors).sort();
    if (keys.length > MAXIMUM_OBJECT_KEYS)
      throw new TypeError("configuration-data-invalid");
    const output: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor))
        throw new TypeError("configuration-data-invalid");
      output[account(key)] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  };
  const output = visit(input, 0);
  if (output === null || Array.isArray(output) || typeof output !== "object")
    throw new TypeError("configuration-data-invalid");
  return output as JsonObject;
};
