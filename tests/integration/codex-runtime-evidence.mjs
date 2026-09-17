import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";

const descriptorRoot =
  process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const sameFileIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const commandOutcome = (line) => {
  const fields = [
    ...line.matchAll(/hook\.command_outcome=(?:"([^"]*)"|([^\s}]+))/gu),
  ];
  if (fields.length < 1 || fields.length > 2)
    throw new Error("integration.codex.hook-log");
  const outcomes = fields.map((match) => match[1] ?? match[2]);
  if (
    outcomes[0] === undefined ||
    outcomes.some((outcome) => outcome !== outcomes[0]) ||
    !/^(?:completed|timeout|spawn_error|stdin_error|wait_error)$/u.test(
      outcomes[0],
    )
  )
    throw new Error("integration.codex.hook-log");
  return outcomes[0];
};

export const classifyCodexSettledTraceObservation = ({
  hookCompleted,
  observationClosed,
  reporterSettled,
  tracePresent,
}) => {
  if (hookCompleted && reporterSettled && tracePresent) return "accepted";
  if (hookCompleted && observationClosed && reporterSettled && !tracePresent)
    return "missing";
  return "pending";
};

export const codexTraceSearchUnavailable = ({
  code,
  signal,
  stderr,
  stdout,
}) => {
  if (
    code !== 5 ||
    signal !== null ||
    !Buffer.isBuffer(stdout) ||
    stdout.length !== 0 ||
    !Buffer.isBuffer(stderr) ||
    stderr.length < 1 ||
    stderr.length > 4_096
  )
    return false;
  return stderr.equals(
    Buffer.from(
      '{"category":"unavailable","code":"traces.unavailable","command":"agentscope traces search","schema":"agentscope.cli.diagnostic.v1"}\n',
    ),
  );
};

export const codexTraceSearchTimedOut = ({
  code,
  deadlineExpired,
  signal,
  stderr,
  stdout,
}) =>
  deadlineExpired === true &&
  code === null &&
  signal === "SIGKILL" &&
  stdout.length === 0 &&
  stderr.length === 0;

export const codexTraceSearchAttemptDeadlines = ({
  now,
  observationDeadline,
}) => {
  if (observationDeadline - now <= 2_500) return null;
  const attemptDeadline = Math.min(observationDeadline - 500, now + 7_000);
  const childDeadline = attemptDeadline - 250;
  if (childDeadline <= now)
    throw new Error("integration.codex.trace-search-deadline");
  return Object.freeze({
    attemptDeadline,
    childDeadline,
    observationDeadline,
  });
};

const readCodexHookLog = ({
  afterRead,
  directoryDescriptor,
  directoryPath,
}) => {
  if (afterRead !== undefined && typeof afterRead !== "function")
    throw new Error("integration.codex.hook-log");
  const parentBefore = fstatSync(directoryDescriptor, { bigint: true });
  const pathBefore = lstatSync(directoryPath, { bigint: true });
  if (
    !parentBefore.isDirectory() ||
    !pathBefore.isDirectory() ||
    !sameFileIdentity(parentBefore, pathBefore)
  )
    throw new Error("integration.codex.hook-log");
  let descriptor;
  try {
    descriptor = openSync(
      `${descriptorRoot}/${directoryDescriptor}/codex-tui.log`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("integration.codex.hook-log", { cause: error });
  }
  let source;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 1_048_576n)
      throw new Error("integration.codex.hook-log");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    afterRead?.();
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== Number(before.size) || !sameFileIdentity(before, after))
      throw new Error("integration.codex.hook-log");
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } catch {
    throw new Error("integration.codex.hook-log");
  } finally {
    closeSync(descriptor);
  }
  const parentAfter = fstatSync(directoryDescriptor, { bigint: true });
  const pathAfter = lstatSync(directoryPath, { bigint: true });
  if (
    !pathAfter.isDirectory() ||
    !sameFileIdentity(parentBefore, parentAfter) ||
    !sameFileIdentity(parentBefore, pathAfter)
  )
    throw new Error("integration.codex.hook-log");
  return source;
};

const codexCommandSpanClose = (source, eventName) => {
  let state = "absent";
  let close;
  for (const line of source.split("\n")) {
    if (!line.includes("codex.hooks.command")) continue;
    const eventFields = [
      ...line.matchAll(/hook\.event_name=(?:"[^"]*"|[^\s}]+)/gu),
    ];
    if (eventFields.length === 0) continue;
    if (eventFields.length !== 1) throw new Error("integration.codex.hook-log");
    if (
      eventFields[0][0] !== `hook.event_name="${eventName}"` &&
      eventFields[0][0] !== `hook.event_name=${eventName}`
    )
      continue;
    const isNew = /: new(?:\s|$)/u.test(line);
    const isClose = /: close(?:\s|$)/u.test(line);
    if (isNew === isClose) throw new Error("integration.codex.hook-log");
    if (isNew) {
      if (state !== "absent") throw new Error("integration.codex.hook-log");
      state = "started";
      continue;
    }
    if (state !== "started") throw new Error("integration.codex.hook-log");
    state = "closed";
    close = line;
  }
  if (state === "absent") return undefined;
  if (state !== "closed" || close === undefined)
    throw new Error("integration.codex.hook-log");
  return close;
};

/**
 * @param {{afterRead?: () => void, directoryDescriptor: number, directoryPath: string}} input
 * @returns {"completed" | "timeout" | "spawn_error" | "stdin_error" | "wait_error" | undefined}
 */
export const classifyCodexStopHookCommand = (input) => {
  const source = readCodexHookLog(input);
  if (source === undefined) return undefined;
  const close = codexCommandSpanClose(source, "Stop");
  return close === undefined ? undefined : commandOutcome(close);
};

const durationUnitMilliseconds = Object.freeze({
  ns: 0.000_001,
  us: 0.001,
  µs: 0.001,
  μs: 0.001,
  ms: 1,
  s: 1_000,
});

const tracingDurationMilliseconds = (line, field) => {
  const matches = [
    ...line.matchAll(
      new RegExp(
        `${field}=([0-9]+(?:\\.[0-9]+)?)(ns|us|µs|μs|ms|s)(?:\\s|$)`,
        "gu",
      ),
    ),
  ];
  if (matches.length !== 1) throw new Error("integration.codex.hook-log");
  const magnitude = Number(matches[0]?.[1]);
  const multiplier = durationUnitMilliseconds[matches[0]?.[2]];
  const milliseconds = magnitude * multiplier;
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new Error("integration.codex.hook-log");
  return milliseconds;
};

/**
 * Returns one terminal Stop command outcome and its complete observed vendor
 * span from the same descriptor snapshot. The span includes vendor mediation,
 * so it is only a proximity observation and never proof of the launcher's
 * internal deadline.
 *
 * @param {{afterRead?: () => void, directoryDescriptor: number, directoryPath: string}} input
 * @returns {{outcome: "completed" | "timeout" | "spawn_error" | "stdin_error" | "wait_error", durationMilliseconds: number} | undefined}
 */
export const inspectCodexStopHookCommand = (input) => {
  const source = readCodexHookLog(input);
  if (source === undefined) return undefined;
  const close = codexCommandSpanClose(source, "Stop");
  if (close === undefined) return undefined;
  const match = Object.freeze({
    outcome: commandOutcome(close),
    durationMilliseconds:
      tracingDurationMilliseconds(close, "time\\.busy") +
      tracingDurationMilliseconds(close, "time\\.idle"),
  });
  if (match.durationMilliseconds > 120_000)
    throw new Error("integration.codex.hook-log");
  return match;
};

/**
 * Returns the complete observed SessionStart command span. This short-lived
 * non-capturing hook is a conservative upper bound on vendor mediation before
 * the exact installed launcher's first instruction.
 *
 * @param {{afterRead?: () => void, directoryDescriptor: number, directoryPath: string}} input
 * @returns {number | undefined}
 */
export const codexSessionStartMediationUpperBoundMilliseconds = (input) => {
  const source = readCodexHookLog(input);
  if (source === undefined) return undefined;
  const close = codexCommandSpanClose(source, "SessionStart");
  if (close === undefined) return undefined;
  if (commandOutcome(close) !== "completed")
    throw new Error("integration.codex.hook-log");
  const span =
    tracingDurationMilliseconds(close, "time\\.busy") +
    tracingDurationMilliseconds(close, "time\\.idle");
  if (!Number.isFinite(span) || span < 0 || span > 1_000)
    throw new Error("integration.codex.hook-mediation");
  return span;
};

const plainRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const validCodexSessionLedgerRecord = (record) =>
  plainRecord(record) &&
  Object.keys(record).sort().join("\0") ===
    "content\0dev\0gid\0ino\0mode\0relativePath\0uid" &&
  typeof record.relativePath === "string" &&
  /^\.codex\/sessions\/\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/rollout-[0-9A-Za-z:.+-]{1,128}\.jsonl$/u.test(
    record.relativePath,
  ) &&
  typeof record.content === "string" &&
  record.content.length <= 2 * 1024 * 1024 &&
  [record.dev, record.ino, record.mode, record.uid, record.gid].every(
    (value) => typeof value === "bigint" && value >= 0n,
  );

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

const codexTurnTerminalId = (ledgers, expectedMessage) => {
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
  return matches[0] ?? null;
};

export const codexTurnTerminalObserved = (ledgers, expectedMessage) =>
  codexTurnTerminalId(ledgers, expectedMessage) !== null;

export const codexTurnTerminalIdAfterBaseline = (
  records,
  baseline,
  expectedMessage,
) => {
  if (
    !Array.isArray(baseline) ||
    baseline.length > 8 ||
    baseline.some((record) => !validCodexSessionLedgerRecord(record)) ||
    !Array.isArray(records) ||
    records.length !== baseline.length ||
    records.some((record) => !validCodexSessionLedgerRecord(record)) ||
    new Set(baseline.map(({ relativePath }) => relativePath)).size !==
      baseline.length ||
    new Set(records.map(({ relativePath }) => relativePath)).size !==
      records.length
  )
    throw new Error("integration.codex.session-ledger");
  if (
    codexTurnTerminalObserved(
      baseline.map(({ content }) => content),
      expectedMessage,
    )
  )
    throw new Error("integration.codex.session-ledger");
  let changedCount = 0;
  for (const prior of baseline) {
    const current = records.find(
      ({ relativePath }) => relativePath === prior.relativePath,
    );
    if (
      current === undefined ||
      current.dev !== prior.dev ||
      current.ino !== prior.ino ||
      current.mode !== prior.mode ||
      current.uid !== prior.uid ||
      current.gid !== prior.gid ||
      !current.content.startsWith(prior.content)
    )
      throw new Error("integration.codex.session-ledger");
    if (current.content.length > prior.content.length) changedCount += 1;
  }
  if (changedCount === 0) return null;
  if (changedCount !== 1) throw new Error("integration.codex.session-ledger");
  return codexTurnTerminalId(
    records.map(({ content }) => content),
    expectedMessage,
  );
};

export const codexTurnTerminalObservedAfterBaseline = (
  records,
  baseline,
  expectedMessage,
) =>
  codexTurnTerminalIdAfterBaseline(records, baseline, expectedMessage) !== null;

export const codexSessionIdentity = (records) => {
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records.some((record) => !validCodexSessionLedgerRecord(record)) ||
    !records[0].content.endsWith("\n")
  )
    throw new Error("integration.codex.session-ledger");
  const matches = [];
  for (const line of records[0].content.split("\n")) {
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("integration.codex.session-ledger");
    }
    if (entry?.type !== "session_meta") continue;
    const sessionId = entry?.payload?.id;
    if (
      typeof sessionId !== "string" ||
      sessionId.length < 1 ||
      sessionId.length > 256
    )
      throw new Error("integration.codex.session-ledger");
    matches.push(sessionId);
  }
  if (matches.length !== 1) throw new Error("integration.codex.session-ledger");
  return matches[0];
};

export const terminalObservationBeforeDeadline = ({
  observed,
  deadline,
  now,
}) => {
  if (
    typeof observed !== "boolean" ||
    !Number.isFinite(deadline) ||
    typeof now !== "function"
  )
    throw new Error("integration.codex.trace-deadline");
  const observedAt = now();
  if (!Number.isFinite(observedAt))
    throw new Error("integration.codex.trace-deadline");
  return observed && observedAt < deadline;
};

/**
 * @param {{deadline: number, now: () => number, record: () => void}} input
 */
export const recordTerminalObservationBeforeDeadline = ({
  deadline,
  now,
  record,
}) => {
  if (typeof record !== "function")
    throw new Error("integration.codex.trace-deadline");
  if (!terminalObservationBeforeDeadline({ observed: true, deadline, now }))
    throw new Error("integration.codex.trace-deadline");
  record();
  if (!terminalObservationBeforeDeadline({ observed: true, deadline, now }))
    throw new Error("integration.codex.trace-deadline");
};

/**
 * @template T
 * @param {{deadline: number, now: () => number, inspect: () => T}} input
 * @returns {T}
 */
export const inspectDiagnosticBeforeDeadline = ({ deadline, now, inspect }) => {
  if (
    typeof inspect !== "function" ||
    !terminalObservationBeforeDeadline({ observed: true, deadline, now })
  )
    throw new Error("integration.codex.trace-deadline");
  const result = inspect();
  if (!terminalObservationBeforeDeadline({ observed: true, deadline, now }))
    throw new Error("integration.codex.trace-deadline");
  return result;
};

/**
 * @param {{
 *   records: Array<{summaries?: Array<{harness?: string, locator?: {traceId?: string}}>}>;
 *   deadline: number;
 *   now: () => number;
 *   record: (phase: string) => void;
 * }} input
 */
export const classifyTraceSearchRecordsBeforeDeadline = ({
  records,
  deadline,
  now,
  record,
}) => {
  if (!terminalObservationBeforeDeadline({ observed: true, deadline, now }))
    throw new Error("integration.codex.trace-deadline");
  const reject = (phase, error) => {
    recordTerminalObservationBeforeDeadline({
      deadline,
      now,
      record: () => record(phase),
    });
    throw new Error(error);
  };
  if (records.length !== 1)
    reject(
      "trace-search-record-count",
      "integration.codex.trace-search-record-count",
    );
  if (!Array.isArray(records[0]?.summaries))
    reject("trace-search-shape", "integration.codex.trace-search-shape");
  if (records[0].summaries.length > 1)
    reject(
      "trace-search-ambiguous",
      "integration.codex.trace-search-ambiguous",
    );
  if (records[0].summaries.length === 0)
    return traceSummaryBeforeDeadline({ summary: null, deadline, now });
  const summary = records[0].summaries[0];
  if (summary?.harness !== "codex")
    reject("trace-search-harness", "integration.codex.trace-search-harness");
  if (typeof summary?.locator?.traceId !== "string")
    reject("trace-search-locator", "integration.codex.trace-search-locator");
  return traceSummaryBeforeDeadline({ summary, deadline, now });
};

export const publishTerminalCompletionBeforeDeadline = async ({
  deadline,
  now,
  record,
  publish,
}) => {
  if (typeof record !== "function" || typeof publish !== "function")
    throw new Error("integration.codex.trace-deadline");
  recordTerminalObservationBeforeDeadline({ deadline, now, record });
  await publish();
};

export const traceSummaryBeforeDeadline = ({ summary, deadline, now }) => {
  if (!Number.isFinite(deadline) || typeof now !== "function")
    throw new Error("integration.codex.trace-deadline");
  const observedAt = now();
  if (!Number.isFinite(observedAt) || observedAt >= deadline)
    throw new Error("integration.codex.trace-deadline");
  return summary;
};

const ledgerLimit = 2 * 1024 * 1024;
const directoryFlags =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
const sameSnapshotIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const openChild = (parent, name, flags) => {
  try {
    return openSync(`${descriptorRoot}/${parent}/${name}`, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const authenticatedEntries = (descriptor, pattern, kind, budget) => {
  const status = fstatSync(descriptor, { bigint: true });
  if (!status.isDirectory())
    throw new Error("integration.codex.session-ledger");
  const entries = readdirSync(`${descriptorRoot}/${descriptor}`, {
    withFileTypes: true,
  });
  budget.count += entries.length;
  if (
    budget.count > 64 ||
    entries.some(
      (entry) =>
        !pattern.test(entry.name) ||
        (kind === "directory" ? !entry.isDirectory() : !entry.isFile()),
    )
  )
    throw new Error("integration.codex.session-ledger");
  return entries.map(({ name }) => name).sort();
};

const localSqliteSettlementError = () =>
  new Error("integration.codex.local-sqlite-settlement");
const localSqliteLifecycleName =
  /^(?:exclusive-fence-v1|intent-v1\.json|operation-phase-v1\.json|ownership-receipt-v1\.json|lease-[a-f0-9]{32}\.json|lease-cleanup-[a-f0-9]{32}\.json)$/u;
const requireDirectory = (parent, name) => {
  const descriptor = openChild(parent, name, directoryFlags);
  if (descriptor === null) throw localSqliteSettlementError();
  return descriptor;
};

export const openLocalSqliteLifecycle = (homeDescriptor) => {
  if (!Number.isSafeInteger(homeDescriptor) || homeDescriptor < 0)
    throw localSqliteSettlementError();
  const homeStatus = fstatSync(homeDescriptor, { bigint: true });
  if (!homeStatus.isDirectory()) throw localSqliteSettlementError();
  const opened = [];
  try {
    const agentscope = requireDirectory(homeDescriptor, ".agentscope");
    opened.push(agentscope);
    const destinations = requireDirectory(agentscope, "destinations");
    opened.push(destinations);
    const localSqlite = requireDirectory(destinations, "local-sqlite");
    opened.push(localSqlite);
    const namespaces = readdirSync(`${descriptorRoot}/${localSqlite}`, {
      withFileTypes: true,
    });
    if (
      namespaces.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(namespaces[0].name) ||
      !namespaces[0].isDirectory()
    )
      throw localSqliteSettlementError();
    const namespace = requireDirectory(localSqlite, namespaces[0].name);
    opened.push(namespace);
    const lifecycle = requireDirectory(namespace, "lifecycle");
    const status = fstatSync(lifecycle, { bigint: true });
    if (!status.isDirectory()) {
      closeSync(lifecycle);
      throw localSqliteSettlementError();
    }
    return lifecycle;
  } catch (error) {
    if (error?.message === "integration.codex.local-sqlite-settlement")
      throw error;
    throw localSqliteSettlementError();
  } finally {
    for (const descriptor of opened.reverse()) closeSync(descriptor);
  }
};

export const localSqliteReporterSettled = (lifecycleDescriptor) => {
  if (!Number.isSafeInteger(lifecycleDescriptor) || lifecycleDescriptor < 0)
    throw localSqliteSettlementError();
  try {
    const before = fstatSync(lifecycleDescriptor, { bigint: true });
    if (!before.isDirectory()) throw localSqliteSettlementError();
    const readEntries = () =>
      readdirSync(`${descriptorRoot}/${lifecycleDescriptor}`, {
        withFileTypes: true,
      });
    const first = readEntries();
    const middle = fstatSync(lifecycleDescriptor, { bigint: true });
    const second = readEntries();
    const after = fstatSync(lifecycleDescriptor, { bigint: true });
    return settledLocalSqliteLifecycleSnapshot({
      before,
      first: first.map((entry) => ({
        kind: entry.isFile() ? "file" : "other",
        name: entry.name,
      })),
      middle,
      second: second.map((entry) => ({
        kind: entry.isFile() ? "file" : "other",
        name: entry.name,
      })),
      after,
    });
  } catch (error) {
    if (error?.message === "integration.codex.local-sqlite-settlement")
      throw error;
    throw localSqliteSettlementError();
  }
};

export const settledLocalSqliteLifecycleSnapshot = ({
  before,
  first,
  middle,
  second,
  after,
}) => {
  if (
    typeof before?.size !== "bigint" ||
    typeof middle?.size !== "bigint" ||
    typeof after?.size !== "bigint" ||
    !Array.isArray(first) ||
    !Array.isArray(second) ||
    first.length > 132 ||
    second.length > 132
  )
    throw localSqliteSettlementError();
  const names = (entries) => {
    if (
      entries.some(
        (entry) =>
          !plainRecord(entry) ||
          entry.kind !== "file" ||
          typeof entry.name !== "string" ||
          !localSqliteLifecycleName.test(entry.name),
      )
    )
      throw localSqliteSettlementError();
    const result = entries.map(({ name }) => name).sort();
    if (new Set(result).size !== result.length)
      throw localSqliteSettlementError();
    return result;
  };
  const firstNames = names(first);
  const secondNames = names(second);
  if (
    !sameSnapshotIdentity(before, middle) ||
    !sameSnapshotIdentity(middle, after) ||
    JSON.stringify(firstNames) !== JSON.stringify(secondNames)
  )
    return false;
  return firstNames.length === 0;
};
const readCapped = (descriptor, maximumBytes = ledgerLimit) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("integration.codex.session-ledger");
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (count === 0) break;
    offset += count;
  }
  if (offset > maximumBytes)
    throw new Error("integration.codex.session-ledger");
  return buffer.subarray(0, offset);
};

const operationalStateError = () =>
  new Error("integration.codex.operational-state");
export const openOperationalStateHealth = (homeDescriptor) => {
  if (!Number.isSafeInteger(homeDescriptor) || homeDescriptor < 0)
    throw operationalStateError();
  const opened = [];
  try {
    const agentscope = requireDirectory(homeDescriptor, ".agentscope");
    opened.push(agentscope);
    const health = requireDirectory(agentscope, "health");
    return health;
  } catch (error) {
    if (error?.message === "integration.codex.local-sqlite-settlement")
      throw operationalStateError();
    throw error;
  } finally {
    for (const descriptor of opened.reverse()) closeSync(descriptor);
  }
};
const exactKeys = (value, expected) =>
  plainRecord(value) && Object.keys(value).sort().join("\0") === expected;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const connectionId = (value) =>
  typeof value === "string" &&
  /^destination-connection-v1-[a-f0-9]{64}$/u.test(value);
const destinationType = (value) =>
  typeof value === "string" &&
  /^@agentscope\/destination-[a-z0-9-]{1,64}$/u.test(value);
const optionalConnectionFields = (entry) =>
  (entry.destinationType === undefined ||
    destinationType(entry.destinationType)) &&
  (entry.connectionId === undefined || connectionId(entry.connectionId));
const sequenceFields = (entry) =>
  nonnegative(entry.sequence) && nonnegative(entry.observedAtUnixMilliseconds);
const diagnosticCodes = new Set([
  "configuration-invalid",
  "configuration-recovery-needed",
  "credential-unavailable",
  "credential-locked",
  "credential-denied",
  "credential-missing",
  "credential-malformed",
  "policy-unavailable",
  "capture-failed",
  "checkpoint-unavailable",
  "native-source-loss",
  "redaction-suppressed",
  "no-route",
  "reporter-rejected",
  "reporter-unavailable",
  "reporter-deadline-exceeded",
  "reporter-outcome-unknown",
  "destination-busy",
  "destination-full",
  "destination-corrupt",
  "destination-migrating",
  "destination-retention",
  "destination-capacity",
]);
const validDiagnostic = (entry) =>
  exactKeys(
    entry,
    [
      "code",
      "configurationGeneration",
      ...(entry?.connectionId === undefined ? [] : ["connectionId"]),
      ...(entry?.destinationType === undefined ? [] : ["destinationType"]),
      "observedAtUnixMilliseconds",
      "sequence",
      "severity",
    ]
      .sort()
      .join("\0"),
  ) &&
  diagnosticCodes.has(entry.code) &&
  ["info", "warning", "error"].includes(entry.severity) &&
  (entry.configurationGeneration === null ||
    nonnegative(entry.configurationGeneration)) &&
  optionalConnectionFields(entry) &&
  sequenceFields(entry);
const validHealth = (entry) =>
  exactKeys(
    entry,
    [
      "configurationGeneration",
      ...(entry?.connectionId === undefined ? [] : ["connectionId"]),
      ...(entry?.destinationType === undefined ? [] : ["destinationType"]),
      "observedAtUnixMilliseconds",
      "outcome",
      "policyMode",
      "receipt",
      "scope",
      "sequence",
      "stage",
    ]
      .sort()
      .join("\0"),
  ) &&
  ["hook", "connection"].includes(entry.scope) &&
  [
    "hook-started",
    "capture",
    "redaction",
    "routing",
    "delivery",
    "remote-acceptance",
  ].includes(entry.stage) &&
  [
    "completed",
    "suppressed",
    "no-route",
    "accepted",
    "rejected",
    "unavailable",
    "deadline-exceeded",
    "outcome-unknown",
  ].includes(entry.outcome) &&
  [
    null,
    "accepted",
    "rejected",
    "unavailable",
    "deadline-exceeded",
    "outcome-unknown",
  ].includes(entry.receipt) &&
  (entry.configurationGeneration === null ||
    nonnegative(entry.configurationGeneration)) &&
  [null, "baseline", "strict"].includes(entry.policyMode) &&
  optionalConnectionFields(entry) &&
  sequenceFields(entry);
const validCheckpoint = (entry) =>
  exactKeys(
    entry,
    "acknowledgedExclusivePosition\0adapterId\0configurationGeneration\0connectionId\0nativeIdentityKind\0observedAtUnixMilliseconds\0positionKind\0sequence\0sourceGeneration\0sourceIdentityDigest",
  ) &&
  typeof entry.adapterId === "string" &&
  /^@agentscope\/harness-[a-z0-9-]{1,64}$/u.test(entry.adapterId) &&
  digest(entry.sourceIdentityDigest) &&
  ["conversation", "run", "session", "thread"].includes(
    entry.nativeIdentityKind,
  ) &&
  nonnegative(entry.sourceGeneration) &&
  ["byte-offset", "event-index", "line", "sequence"].includes(
    entry.positionKind,
  ) &&
  nonnegative(entry.acknowledgedExclusivePosition) &&
  nonnegative(entry.configurationGeneration) &&
  connectionId(entry.connectionId) &&
  sequenceFields(entry);
const validHistory = (document) => {
  const entries = [
    ...document.diagnostics,
    ...document.health,
    ...document.checkpoints,
  ];
  const ordered = (values) =>
    values.every(
      (entry, index) =>
        index === 0 ||
        values[index - 1].observedAtUnixMilliseconds <
          entry.observedAtUnixMilliseconds ||
        (values[index - 1].observedAtUnixMilliseconds ===
          entry.observedAtUnixMilliseconds &&
          values[index - 1].sequence < entry.sequence),
    );
  return (
    new Set(entries.map(({ sequence }) => sequence)).size === entries.length &&
    entries.every(({ sequence }) => sequence < document.nextSequence) &&
    ordered(document.diagnostics) &&
    ordered(document.health) &&
    ordered(document.checkpoints)
  );
};
const decodeOperationalState = (bytes) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = JSON.parse(text);
  if (
    !exactKeys(
      document,
      "checkpoints\0diagnostics\0health\0losses\0nextSequence\0version",
    ) ||
    document.version !== 1 ||
    !nonnegative(document.nextSequence) ||
    !exactKeys(document.losses, "checkpoints\0diagnostics\0health") ||
    !nonnegative(document.losses.diagnostics) ||
    !nonnegative(document.losses.health) ||
    !nonnegative(document.losses.checkpoints) ||
    !Array.isArray(document.diagnostics) ||
    document.diagnostics.length > 128 ||
    document.diagnostics.some((entry) => !validDiagnostic(entry)) ||
    !Array.isArray(document.health) ||
    document.health.length > 64 ||
    document.health.some((entry) => !validHealth(entry)) ||
    !Array.isArray(document.checkpoints) ||
    document.checkpoints.length > 128 ||
    document.checkpoints.some((entry) => !validCheckpoint(entry)) ||
    !validHistory(document)
  )
    throw operationalStateError();
  const normalized = {
    version: document.version,
    nextSequence: document.nextSequence,
    losses: {
      diagnostics: document.losses.diagnostics,
      health: document.losses.health,
      checkpoints: document.losses.checkpoints,
    },
    diagnostics: document.diagnostics.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      configurationGeneration: entry.configurationGeneration,
      ...(entry.destinationType === undefined
        ? {}
        : { destinationType: entry.destinationType }),
      ...(entry.connectionId === undefined
        ? {}
        : { connectionId: entry.connectionId }),
      sequence: entry.sequence,
      observedAtUnixMilliseconds: entry.observedAtUnixMilliseconds,
    })),
    health: document.health.map((entry) => ({
      scope: entry.scope,
      stage: entry.stage,
      outcome: entry.outcome,
      configurationGeneration: entry.configurationGeneration,
      policyMode: entry.policyMode,
      ...(entry.destinationType === undefined
        ? {}
        : { destinationType: entry.destinationType }),
      ...(entry.connectionId === undefined
        ? {}
        : { connectionId: entry.connectionId }),
      receipt: entry.receipt,
      sequence: entry.sequence,
      observedAtUnixMilliseconds: entry.observedAtUnixMilliseconds,
    })),
    checkpoints: document.checkpoints.map((entry) => ({
      adapterId: entry.adapterId,
      sourceIdentityDigest: entry.sourceIdentityDigest,
      nativeIdentityKind: entry.nativeIdentityKind,
      sourceGeneration: entry.sourceGeneration,
      positionKind: entry.positionKind,
      acknowledgedExclusivePosition: entry.acknowledgedExclusivePosition,
      configurationGeneration: entry.configurationGeneration,
      connectionId: entry.connectionId,
      sequence: entry.sequence,
      observedAtUnixMilliseconds: entry.observedAtUnixMilliseconds,
    })),
  };
  if (`${JSON.stringify(normalized)}\n` !== text) throw operationalStateError();
  return normalized;
};
const readOperationalState = (healthDescriptor, unstable) => {
  if (!Number.isSafeInteger(healthDescriptor) || healthDescriptor < 0)
    throw operationalStateError();
  const descriptor = openChild(
    healthDescriptor,
    "operational-state-v1.json",
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  if (descriptor === null) return null;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readCapped(descriptor, 262_144);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      !sameSnapshotIdentity(before, after) ||
      bytes.length !== Number(before.size)
    ) {
      if (unstable === "retry") return undefined;
      throw operationalStateError();
    }
    return decodeOperationalState(bytes);
  } catch (error) {
    if (error?.message === "integration.codex.operational-state") throw error;
    throw operationalStateError();
  } finally {
    closeSync(descriptor);
  }
};

export const localSqliteAcceptanceBaseline = (healthDescriptor) => {
  const document = readOperationalState(healthDescriptor, "reject") ?? {
    version: 1,
    nextSequence: 0,
    losses: { diagnostics: 0, health: 0, checkpoints: 0 },
    diagnostics: [],
    health: [],
    checkpoints: [],
  };
  return Object.freeze({
    nextSequence: document.nextSequence,
    losses: Object.freeze({ ...document.losses }),
    diagnostics: Object.freeze(
      document.diagnostics.map((entry) => Object.freeze({ ...entry })),
    ),
    health: Object.freeze(
      document.health.map((entry) => Object.freeze({ ...entry })),
    ),
    checkpoints: Object.freeze(
      document.checkpoints.map((entry) => Object.freeze({ ...entry })),
    ),
  });
};

const healthKey = (entry) =>
  entry.scope === "hook" ? "hook" : `connection:${entry.connectionId}`;
const checkpointKey = (entry) =>
  [
    entry.adapterId,
    entry.sourceIdentityDigest,
    entry.nativeIdentityKind,
    entry.sourceGeneration,
    entry.positionKind,
    entry.connectionId,
  ].join("\0");
const preservesHistory = (document, baseline, field, keyOf) => {
  const before = baseline[field];
  const after = document[field];
  if (
    new Set(before.map(({ sequence }) => sequence)).size !== before.length ||
    new Set(after.map(({ sequence }) => sequence)).size !== after.length ||
    after.some(({ sequence }) => sequence >= document.nextSequence)
  )
    return false;
  const retained = after.filter(
    ({ sequence }) => sequence < baseline.nextSequence,
  );
  const beforeBySequence = new Map(
    before.map((entry) => [entry.sequence, entry]),
  );
  if (
    retained.some(
      (entry) =>
        JSON.stringify(beforeBySequence.get(entry.sequence)) !==
        JSON.stringify(entry),
    )
  )
    return false;
  const replacements =
    keyOf === undefined
      ? new Set()
      : new Set(
          after
            .filter(({ sequence }) => sequence >= baseline.nextSequence)
            .map(keyOf),
        );
  if (
    keyOf !== undefined &&
    (new Set(before.map(keyOf)).size !== before.length ||
      new Set(after.map(keyOf)).size !== after.length)
  )
    return false;
  const baselineWithoutReplacements = before.filter(
    (entry) => keyOf === undefined || !replacements.has(keyOf(entry)),
  );
  const omittedAsLoss = baselineWithoutReplacements.length - retained.length;
  return (
    omittedAsLoss >= 0 &&
    retained.length <= before.length &&
    JSON.stringify(retained) ===
      JSON.stringify(baselineWithoutReplacements.slice(omittedAsLoss)) &&
    document.losses[field] === baseline.losses[field] + omittedAsLoss
  );
};

export const localSqliteAcceptanceObservedAfterBaseline = (
  healthDescriptor,
  baseline,
) => {
  if (
    !exactKeys(
      baseline,
      "checkpoints\0diagnostics\0health\0losses\0nextSequence",
    ) ||
    !nonnegative(baseline.nextSequence) ||
    !exactKeys(baseline.losses, "checkpoints\0diagnostics\0health") ||
    !nonnegative(baseline.losses.diagnostics) ||
    !nonnegative(baseline.losses.health) ||
    !nonnegative(baseline.losses.checkpoints) ||
    !Array.isArray(baseline.diagnostics) ||
    baseline.diagnostics.length > 128 ||
    baseline.diagnostics.some((entry) => !validDiagnostic(entry)) ||
    !Array.isArray(baseline.health) ||
    baseline.health.length > 64 ||
    baseline.health.some((entry) => !validHealth(entry)) ||
    !Array.isArray(baseline.checkpoints) ||
    baseline.checkpoints.length > 128 ||
    baseline.checkpoints.some((entry) => !validCheckpoint(entry)) ||
    !validHistory(baseline)
  )
    throw operationalStateError();
  const document = readOperationalState(healthDescriptor, "retry");
  if (document === null || document === undefined) return false;
  if (
    document.nextSequence < baseline.nextSequence ||
    !preservesHistory(document, baseline, "diagnostics") ||
    !preservesHistory(document, baseline, "health", healthKey) ||
    !preservesHistory(document, baseline, "checkpoints", checkpointKey)
  )
    throw operationalStateError();
  const entries = document.health;
  const matches = entries.filter((entry) => {
    return (
      entry.sequence >= baseline.nextSequence &&
      entry.sequence < document.nextSequence &&
      entry.scope === "connection" &&
      entry.stage === "remote-acceptance" &&
      entry.outcome === "accepted" &&
      entry.receipt === "accepted" &&
      entry.destinationType === "@agentscope/destination-local-sqlite" &&
      typeof entry.connectionId === "string"
    );
  });
  if (matches.length > 1) throw operationalStateError();
  return matches.length === 1;
};
export const settledCodexLedgerSnapshot = ({
  before,
  first,
  middle,
  second,
  after,
}) => {
  if (
    !Buffer.isBuffer(first) ||
    !Buffer.isBuffer(second) ||
    typeof before?.size !== "bigint" ||
    typeof middle?.size !== "bigint" ||
    typeof after?.size !== "bigint"
  )
    throw new Error("integration.codex.session-ledger");
  if (
    !sameSnapshotIdentity(before, middle) ||
    !sameSnapshotIdentity(middle, after) ||
    first.length !== Number(before.size) ||
    !first.equals(second)
  )
    return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(first);
  } catch {
    throw new Error("integration.codex.session-ledger");
  }
};
const readStableLedger = (parent, relativePath, name) => {
  const descriptor = openChild(
    parent,
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  if (descriptor === null) return null;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("integration.codex.session-ledger");
    if (before.size < 1n) return null;
    if (before.size > BigInt(ledgerLimit))
      throw new Error("integration.codex.session-ledger");
    const first = readCapped(descriptor);
    const middle = fstatSync(descriptor, { bigint: true });
    const second = readCapped(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const content = settledCodexLedgerSnapshot({
      before,
      first,
      middle,
      second,
      after,
    });
    return content === null
      ? null
      : Object.freeze({
          relativePath: `${relativePath}/${name}`,
          dev: after.dev,
          ino: after.ino,
          mode: after.mode,
          uid: after.uid,
          gid: after.gid,
          content,
        });
  } finally {
    closeSync(descriptor);
  }
};

export const readCodexSessionLedgerRecords = (homeDescriptor) => {
  if (!Number.isSafeInteger(homeDescriptor) || homeDescriptor < 0)
    throw new Error("integration.codex.session-ledger");
  const homeStatus = fstatSync(homeDescriptor, { bigint: true });
  if (!homeStatus.isDirectory())
    throw new Error("integration.codex.session-ledger");
  const budget = { count: 0 };
  const opened = [];
  const openDirectories = (parents, pattern) => {
    const children = [];
    for (const parent of parents) {
      for (const name of authenticatedEntries(
        parent.descriptor,
        pattern,
        "directory",
        budget,
      )) {
        const descriptor = openChild(parent.descriptor, name, directoryFlags);
        if (descriptor !== null)
          children.push({
            descriptor,
            relativePath: `${parent.relativePath}/${name}`,
          });
      }
    }
    opened.push(...children.map(({ descriptor }) => descriptor));
    return children;
  };
  try {
    const codex = openChild(homeDescriptor, ".codex", directoryFlags);
    if (codex === null) return [];
    opened.push(codex);
    const sessions = openChild(codex, "sessions", directoryFlags);
    if (sessions === null) return [];
    opened.push(sessions);
    let directories = openDirectories(
      [{ descriptor: sessions, relativePath: ".codex/sessions" }],
      /^\d{4}$/u,
    );
    directories = openDirectories(directories, /^(?:0[1-9]|1[0-2])$/u);
    directories = openDirectories(directories, /^(?:0[1-9]|[12]\d|3[01])$/u);
    const ledgers = [];
    for (const directory of directories) {
      const names = authenticatedEntries(
        directory.descriptor,
        /^rollout-[0-9A-Za-z:.+-]{1,128}\.jsonl$/u,
        "file",
        budget,
      );
      for (const name of names) {
        const record = readStableLedger(
          directory.descriptor,
          directory.relativePath,
          name,
        );
        if (record !== null) ledgers.push(record);
      }
    }
    if (ledgers.length > 8) throw new Error("integration.codex.session-ledger");
    return ledgers;
  } finally {
    for (const descriptor of opened.reverse()) closeSync(descriptor);
  }
};

export const readCodexSessionLedgers = (homeDescriptor) =>
  readCodexSessionLedgerRecords(homeDescriptor).map(({ content }) => content);

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

/**
 * @param {{
 *   deadline: number,
 *   now: () => number,
 *   request: (signal: AbortSignal) => Promise<readonly unknown[]>,
 *   wait: (milliseconds: number) => Promise<void>
 * }} options
 * @returns {Promise<readonly unknown[]>}
 */
export const waitForModelRequestBeforeDeadline = async ({
  deadline,
  now,
  request,
  wait,
}) => {
  if (
    !Number.isFinite(deadline) ||
    typeof now !== "function" ||
    typeof request !== "function" ||
    typeof wait !== "function"
  )
    throw new Error("integration.codex.diagnostic-deadline");
  while (true) {
    const remainingMilliseconds = deadline - now();
    if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0)
      throw new Error("integration.codex.diagnostic-deadline");
    const controller = new AbortController();
    let timer;
    const pending = Promise.resolve().then(() => request(controller.signal));
    try {
      const records = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("integration.codex.diagnostic-deadline"));
          }, Math.ceil(remainingMilliseconds));
        }),
      ]);
      if (now() >= deadline) {
        controller.abort();
        throw new Error("integration.codex.diagnostic-deadline");
      }
      if (!Array.isArray(records))
        throw new Error("integration.codex.model-request");
      if (records.length > 0) return records;
    } catch (error) {
      if (controller.signal.aborted) {
        await pending.catch(() => undefined);
        throw new Error("integration.codex.diagnostic-deadline", {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    try {
      await waitWithinObservationDeadline({
        deadline,
        maximumWaitMilliseconds: 25,
        now,
        wait,
      });
    } catch {
      throw new Error("integration.codex.diagnostic-deadline");
    }
  }
};
