import { lstatSync, readFileSync } from "node:fs";

const plainRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const readBoundedJsonResponse = async (response, maximumBytes) => {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    response.body === null
  )
    throw new Error("integration.codex.sidecar");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)
  )
    throw new Error("integration.codex.sidecar");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new Error("integration.codex.sidecar");
      length += value.byteLength;
      if (length > maximumBytes) throw new Error("integration.codex.sidecar");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("integration.codex.sidecar");
  }
};

export const boundedRequestLedger = (value) => {
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some((entry) => !plainRecord(entry))
  )
    throw new Error("integration.codex.model-request");
  return Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
};

export const readHookLifecycleLedger = (path) => {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 16_384)
    throw new Error("integration.codex.hook-lifecycle");
  const source = readFileSync(path, "utf8");
  if (Buffer.byteLength(source) !== status.size || !source.endsWith("\n"))
    throw new Error("integration.codex.hook-lifecycle");
  try {
    const records = source
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line));
    if (records.length > 8 || records.some((record) => !plainRecord(record)))
      throw new Error("integration.codex.hook-lifecycle");
    return Object.freeze(records.map((record) => Object.freeze(record)));
  } catch {
    throw new Error("integration.codex.hook-lifecycle");
  }
};
