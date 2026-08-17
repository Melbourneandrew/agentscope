const arrayIsArray = Array.isArray;
const jsonStringify = JSON.stringify;
const numberIsFinite = Number.isFinite;
const objectIs = Object.is;
const objectKeys = Object.keys;

const invalid = () => new Error("protocol.codec.invalid");

export const serializeCanonicalJsonData = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return jsonStringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && numberIsFinite(value))
    return objectIs(value, -0) ? "0" : String(value);
  if (arrayIsArray(value)) {
    let output = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index !== 0) output += ",";
      output += serializeCanonicalJsonData(value[index]);
    }
    return `${output}]`;
  }
  if (typeof value === "object" && value !== undefined) {
    const record = value as Record<string, unknown>;
    const keys = objectKeys(record);
    let output = "{";
    for (let index = 0; index < keys.length; index += 1) {
      if (index !== 0) output += ",";
      const key = keys[index]!;
      output += `${jsonStringify(key)}:${serializeCanonicalJsonData(record[key])}`;
    }
    return `${output}}`;
  }
  throw invalid();
};
