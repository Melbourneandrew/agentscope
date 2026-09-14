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

export const codexTurnTerminalObserved = (ledgers, expectedMessage) => {
  if (
    !Array.isArray(ledgers) ||
    ledgers.length > 8 ||
    ledgers.some(
      (ledger) => typeof ledger !== "string" || ledger.length > 2 * 1024 * 1024,
    ) ||
    typeof expectedMessage !== "string" ||
    expectedMessage.length < 1 ||
    expectedMessage.length > 1_024
  )
    throw new Error("integration.codex.session-ledger");
  const matches = [];
  for (const ledger of ledgers) {
    const complete = ledger.endsWith("\n")
      ? ledger
      : ledger.slice(0, ledger.lastIndexOf("\n") + 1);
    const lines = complete.split("\n");
    if (lines.length > 4_097)
      throw new Error("integration.codex.session-ledger");
    for (const line of lines) {
      if (line === "") continue;
      if (line.length > 262_144)
        throw new Error("integration.codex.session-ledger");
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error("integration.codex.session-ledger");
      }
      if (
        entry?.type === "event_msg" &&
        entry?.payload?.type === "task_complete"
      ) {
        if (
          typeof entry.payload.turn_id !== "string" ||
          entry.payload.turn_id.length < 1 ||
          entry.payload.turn_id.length > 256 ||
          entry.payload.last_agent_message !== expectedMessage
        )
          throw new Error("integration.codex.session-ledger");
        matches.push(entry.payload.turn_id);
      }
    }
  }
  if (matches.length > 1) throw new Error("integration.codex.session-ledger");
  return matches.length === 1;
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
