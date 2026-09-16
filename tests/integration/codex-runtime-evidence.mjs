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
  records,
  baseline,
  expectedMessage,
) => {
  const validRecord = (record) =>
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
  if (
    !Array.isArray(baseline) ||
    baseline.length > 8 ||
    baseline.some((record) => !validRecord(record)) ||
    !Array.isArray(records) ||
    records.length !== baseline.length ||
    records.some((record) => !validRecord(record)) ||
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
  if (changedCount === 0) return false;
  if (changedCount !== 1) throw new Error("integration.codex.session-ledger");
  return codexTurnTerminalObserved(
    records.map(({ content }) => content),
    expectedMessage,
  );
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

export const sessionStartProcessSetDrained = ({
  baseline,
  current,
  codexIdentity,
}) => {
  const validIdentity = (identity) =>
    plainRecord(identity) &&
    Object.keys(identity).sort().join("\0") ===
      "executable\0pid\0startIdentity" &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.startIdentity === "string" &&
    /^\d+$/u.test(identity.startIdentity) &&
    typeof identity.executable === "string" &&
    identity.executable.length > 0 &&
    identity.executable.length <= 4_096;
  if (
    !Array.isArray(baseline) ||
    baseline.length > 64 ||
    baseline.some((identity) => !validIdentity(identity)) ||
    !Array.isArray(current) ||
    current.length > 64 ||
    current.some((identity) => !validIdentity(identity)) ||
    !validIdentity(codexIdentity)
  )
    throw new Error("integration.codex.process-set");
  const sameIdentity = (left, right) =>
    left.pid === right.pid &&
    left.startIdentity === right.startIdentity &&
    left.executable === right.executable;
  return (
    current.filter((identity) => sameIdentity(identity, codexIdentity))
      .length === 1 &&
    current.every(
      (identity) =>
        sameIdentity(identity, codexIdentity) ||
        baseline.some((prior) => sameIdentity(identity, prior)),
    )
  );
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
