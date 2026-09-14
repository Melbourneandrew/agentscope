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

export const waitWithinObservationDeadline = async ({
  deadline,
  maximumWaitMilliseconds,
  now,
  wait,
}) => {
  if (
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(maximumWaitMilliseconds) ||
    maximumWaitMilliseconds < 1 ||
    typeof now !== "function" ||
    typeof wait !== "function"
  )
    throw new Error("integration.codex.trace-deadline");
  const remainingMilliseconds = deadline - now();
  if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0)
    throw new Error("integration.codex.trace-deadline");
  await wait(Math.min(maximumWaitMilliseconds, remainingMilliseconds));
  if (now() >= deadline) throw new Error("integration.codex.trace-deadline");
};
