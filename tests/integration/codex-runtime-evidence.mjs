import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";

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

export const codexTurnTerminalObservedAfterBaseline = (
  ledgers,
  baseline,
  expectedMessage,
) => {
  if (
    !Array.isArray(baseline) ||
    baseline.length > 8 ||
    baseline.some(
      (ledger) => typeof ledger !== "string" || ledger.length > 2 * 1024 * 1024,
    ) ||
    !Array.isArray(ledgers) ||
    ledgers.length < baseline.length ||
    ledgers.length > baseline.length + 1
  )
    throw new Error("integration.codex.session-ledger");
  if (codexTurnTerminalObserved(baseline, expectedMessage))
    throw new Error("integration.codex.session-ledger");
  const unmatched = [...ledgers];
  let changed = false;
  for (const prior of baseline) {
    const matches = unmatched
      .map((current, index) => ({ current, index }))
      .filter(({ current }) => current.startsWith(prior));
    if (matches.length !== 1)
      throw new Error("integration.codex.session-ledger");
    const [{ current, index }] = matches;
    changed ||= current.length > prior.length;
    unmatched.splice(index, 1);
  }
  changed ||= unmatched.length === 1;
  if (!changed) return false;
  return codexTurnTerminalObserved(ledgers, expectedMessage);
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

const ledgerLimit = 2 * 1024 * 1024;
const descriptorRoot =
  process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
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
const readCapped = (descriptor) => {
  const buffer = Buffer.allocUnsafe(ledgerLimit + 1);
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
  if (offset > ledgerLimit) throw new Error("integration.codex.session-ledger");
  return buffer.subarray(0, offset);
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
const readStableLedger = (parent, name) => {
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
    return settledCodexLedgerSnapshot({
      before,
      first,
      middle,
      second,
      after,
    });
  } finally {
    closeSync(descriptor);
  }
};

export const readCodexSessionLedgers = (homeDescriptor) => {
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
        parent,
        pattern,
        "directory",
        budget,
      )) {
        const descriptor = openChild(parent, name, directoryFlags);
        if (descriptor !== null) children.push(descriptor);
      }
    }
    opened.push(...children);
    return children;
  };
  try {
    const codex = openChild(homeDescriptor, ".codex", directoryFlags);
    if (codex === null) return [];
    opened.push(codex);
    const sessions = openChild(codex, "sessions", directoryFlags);
    if (sessions === null) return [];
    opened.push(sessions);
    let directories = openDirectories([sessions], /^\d{4}$/u);
    directories = openDirectories(directories, /^(?:0[1-9]|1[0-2])$/u);
    directories = openDirectories(directories, /^(?:0[1-9]|[12]\d|3[01])$/u);
    const ledgers = [];
    for (const directory of directories) {
      const names = authenticatedEntries(
        directory,
        /^rollout-[0-9A-Za-z:.+-]{1,128}\.jsonl$/u,
        "file",
        budget,
      );
      for (const name of names) {
        const content = readStableLedger(directory, name);
        if (content !== null) ledgers.push(content);
      }
    }
    if (ledgers.length > 8) throw new Error("integration.codex.session-ledger");
    return ledgers;
  } finally {
    for (const descriptor of opened.reverse()) closeSync(descriptor);
  }
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
