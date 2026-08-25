"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { createInterface } = require("node:readline");

const within = (promise, milliseconds) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("destination.local-sqlite.native-execution.invalid")),
      milliseconds,
    );
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const databaseFamily = () =>
  Object.freeze(
    readdirSync("/evidence")
      .filter((name) =>
        ["traces.sqlite", "traces.sqlite-shm", "traces.sqlite-wal"].includes(
          name,
        ),
      )
      .sort()
      .map((name) => {
        const state = statSync(`/evidence/${name}`, { bigint: true });
        return Object.freeze({
          name,
          physicalIdentity: `dev:${state.dev}:ino:${state.ino}`,
        });
      }),
  );

// eslint-disable-next-line max-lines-per-function -- the packed Reporter witness keeps setup, permission, settlement, and external row evidence adjacent.
const executePackedReporterChild = async (loader) => {
  const databasePath = "/evidence/traces.sqlite";
  const database = loader.open(databasePath);
  database.exec(`
    CREATE TABLE destination_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE traces (
      delivery_identity TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      start_time_unix_nano TEXT NOT NULL,
      start_time_sort_key TEXT NOT NULL,
      admission_time_unix_nano TEXT NOT NULL,
      admission_time_sort_key TEXT NOT NULL,
      protocol_compatibility_id TEXT NOT NULL,
      payload BLOB NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE trace_dimensions (
      delivery_identity TEXT NOT NULL REFERENCES traces(delivery_identity) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (delivery_identity, kind, value)
    ) STRICT;
  `);
  database.close();
  const payloadUtf8 = '{"schemaVersion":1}';
  const nonce = "1".repeat(32);
  const prepared = Object.freeze({
    deliveryIdentity: "2".repeat(64),
    traceId: "3".repeat(32),
    startTimeUnixNano: "4",
    startTimeSortKey: "4".padStart(20, "0"),
    admissionTimeUnixNano: "5",
    admissionTimeSortKey: "5".padStart(20, "0"),
    protocolCompatibilityId: "p".repeat(1_024),
    payloadUtf8,
    payloadSha256: createHash("sha256").update(payloadUtf8).digest("hex"),
    payloadBytes: Buffer.byteLength(payloadUtf8),
    dimensions: Object.freeze([]),
  });
  const header = Object.freeze({
    type: "attempt-header",
    nonce,
    databasePath,
    databaseFamily: databaseFamily(),
    maximumWorkMilliseconds: 10_000,
    policy: Object.freeze({
      maximumAgeNanoseconds: "1",
      maximumPayloadBytes: 1_048_576,
      maximumTraceCount: 16,
    }),
    preparedCount: 1,
    admissionTimeUnixNano: "5",
  });
  const worker = spawn(
    process.execPath,
    [
      "/work/node_modules/@agentscope/cli/dist/internal/local-sqlite-runtime/reporter-child.js",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = new Promise((resolve) =>
    worker.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let stderr = Buffer.alloc(0);
  worker.stderr.on("data", (value) => {
    stderr = Buffer.concat([stderr, Buffer.from(value)]);
    if (stderr.byteLength > 4_096) worker.kill("SIGKILL");
  });
  const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  worker.stdin.write(
    `${JSON.stringify(header)}\n${JSON.stringify({ type: "trace", nonce, value: prepared })}\n`,
    "utf8",
  );
  const readyLine = await within(lines.next(), 5_000);
  if (readyLine.done)
    throw new Error(
      `reporter-child-ready-line:${JSON.stringify(await within(exit, 1_000))}:stderr=${stderr.subarray(0, 512).toString("utf8")}`,
    );
  const ready = JSON.parse(readyLine.value);
  assert.deepEqual(Object.keys(ready), [
    "type",
    "nonce",
    "pid",
    "startIdentity",
  ]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.nonce, nonce);
  assert.equal(ready.pid, worker.pid);
  assert.match(ready.startIdentity, /^(?!0{32})[a-f0-9]{32}$/u);
  worker.stdin.end(`${JSON.stringify({ type: "permission", nonce })}\n`);
  const resultLine = await within(lines.next(), 10_000);
  assert.equal(resultLine.done, false, "reporter-child-result-line");
  const reporterResult = JSON.parse(resultLine.value);
  if (reporterResult.receipt?.outcome !== "accepted") {
    const diagnostic = loader.open(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    const rowCount = diagnostic
      .prepare("SELECT count(*) AS count FROM traces")
      .get().count;
    diagnostic.close();
    throw new Error(
      `reporter-child-diagnostic:${reporterResult.receipt?.outcome ?? "missing"}:rows=${rowCount}:family=${databaseFamily()
        .map(({ name }) => name)
        .join(",")}`,
    );
  }
  assert.deepEqual(reporterResult, {
    type: "result",
    nonce,
    receipt: { outcome: "accepted" },
  });
  assert.deepEqual(await within(exit, 5_000), { code: 0, signal: null });
  assert.equal(stderr.byteLength, 0);
  const verified = loader.open(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  assert.deepEqual(
    verified
      .prepare(
        "SELECT delivery_identity, trace_id, admission_time_unix_nano FROM traces",
      )
      .get(),
    {
      delivery_identity: "2".repeat(64),
      trace_id: "3".repeat(32),
      admission_time_unix_nano: "5",
    },
  );
  verified.close();
};

const executePackedRetrieverChild = async () => {
  const databasePath = "/evidence/traces.sqlite";
  const nonce = "4".repeat(32);
  const maximumWorkMilliseconds = 10_000;
  const dimensions = "";
  const sql = `SELECT t.delivery_identity, t.trace_id, t.start_time_sort_key,
       t.admission_time_sort_key, t.protocol_compatibility_id,
       t.payload_sha256, t.payload_bytes
FROM traces t
  WHERE t.delivery_identity = (
    SELECT MIN(t2.delivery_identity) FROM traces t2
    WHERE t2.trace_id = t.trace_id
      AND t2.admission_time_sort_key >= :retentionCutoffSortKey
  )
  AND t.start_time_sort_key < :toSortKey
  AND t.admission_time_sort_key >= :retentionCutoffSortKey
  AND (:fromSortKey = '' OR t.start_time_sort_key >= :fromSortKey)
  AND (:traceId = '' OR t.trace_id = :traceId)
  AND (:cursorStart = '' OR t.start_time_sort_key < :cursorStart OR
       (t.start_time_sort_key = :cursorStart AND t.trace_id > :cursorTraceId))
  ${dimensions}
ORDER BY t.start_time_sort_key DESC, t.trace_id ASC
LIMIT :maximumRows`;
  const request = Object.freeze({
    type: "retrieve",
    nonce,
    databasePath,
    databaseFamily: databaseFamily(),
    maximumWorkMilliseconds,
    policy: Object.freeze({
      maximumAgeNanoseconds: "1",
      maximumPayloadBytes: 1_048_576,
      maximumTraceCount: 16,
    }),
    operation: "search",
    plan: Object.freeze({
      planVersion: 1,
      sql,
      parameters: Object.freeze({
        cursorStart: "",
        cursorTraceId: "",
        fromSortKey: "",
        maximumRows: 2,
        toSortKey: "9".repeat(20),
        traceId: "",
      }),
      maximumRows: 2,
      maximumResponseBytes: 1_000_000,
      maximumWorkMilliseconds,
      retentionCutoffParameter: "retentionCutoffSortKey",
    }),
  });
  const worker = spawn(
    process.execPath,
    [
      "/work/node_modules/@agentscope/cli/dist/internal/local-sqlite-runtime/retriever-child.js",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = new Promise((resolve) =>
    worker.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let stderr = Buffer.alloc(0);
  worker.stderr.on("data", (value) => {
    stderr = Buffer.concat([stderr, Buffer.from(value)]);
    if (stderr.byteLength > 4_096) worker.kill("SIGKILL");
  });
  const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  worker.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
  const readyLine = await within(lines.next(), 5_000);
  assert.equal(readyLine.done, false, "retriever-child-ready-line");
  const ready = JSON.parse(readyLine.value);
  assert.deepEqual(Object.keys(ready), [
    "type",
    "nonce",
    "pid",
    "startIdentity",
  ]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.nonce, nonce);
  assert.equal(ready.pid, worker.pid);
  worker.stdin.end(`${JSON.stringify({ type: "permission", nonce })}\n`);
  const resultLine = await within(lines.next(), 10_000);
  assert.equal(resultLine.done, false, "retriever-child-result-line");
  const result = JSON.parse(resultLine.value);
  assert.equal(result.type, "retrieval-result");
  assert.equal(result.nonce, nonce);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.rows.length, 1);
  assert.equal(result.evidence.rows[0].deliveryIdentity, "2".repeat(64));
  assert.deepEqual(await within(exit, 5_000), { code: 0, signal: null });
  assert.equal(stderr.byteLength, 0);
};

void (async () => {
  const manifestDigest = process.env.AGENTSCOPE_NATIVE_MANIFEST_DIGEST;
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestDigest))
    throw new Error("destination.local-sqlite.native-execution.invalid");
  const loader =
    require("/work/node_modules/@agentscope/cli/dist/internal/local-sqlite/loader/owned-loader.cjs").load(
      Object.freeze({
        manifestDigest,
        nativeTupleId: "node127-linux-x64-glibc",
        platformTupleId: "linux-x64-node22-ci-ext4-proposed",
      }),
    );
  const database = loader.open("/evidence/proof.sqlite");
  database.exec("CREATE TABLE proof(value TEXT NOT NULL)");
  database.prepare("INSERT INTO proof VALUES (?)").run("packed-ok");
  database.close();
  const proofDescriptor = openSync(
    "/evidence/proof.sqlite",
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    renameSync("/evidence/proof.sqlite", "/evidence/proof-retained.sqlite");
    writeFileSync("/evidence/proof.sqlite", "replacement-canary", {
      mode: 0o600,
    });
    const descriptorDatabase = loader.openDescriptor(proofDescriptor, {
      fileMustExist: true,
      readonly: true,
    });
    assert.deepEqual(
      descriptorDatabase.prepare("SELECT value FROM proof").all(),
      [{ value: "packed-ok" }],
    );
    descriptorDatabase.close();
    assert.equal(
      readFileSync("/evidence/proof.sqlite", "utf8"),
      "replacement-canary",
    );
  } finally {
    closeSync(proofDescriptor);
    unlinkSync("/evidence/proof.sqlite");
    renameSync("/evidence/proof-retained.sqlite", "/evidence/proof.sqlite");
  }
  writeFileSync("/evidence/exchange-candidate", "candidate", { mode: 0o600 });
  writeFileSync("/evidence/exchange-active", "active", { mode: 0o600 });
  const exchangeDirectory = openSync(
    "/evidence",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const candidate = statSync("/evidence/exchange-candidate", {
      bigint: true,
    });
    const active = statSync("/evidence/exchange-active", { bigint: true });
    assert.equal(
      loader.exchangeOwnedFiles(exchangeDirectory, {
        sourceName: "exchange-candidate",
        destinationName: "exchange-active",
        sourceDevice: candidate.dev.toString(),
        sourceInode: candidate.ino.toString(),
        destinationDevice: active.dev.toString(),
        destinationInode: active.ino.toString(),
      }),
      "exchanged",
    );
    assert.equal(
      readFileSync("/evidence/exchange-active", "utf8"),
      "candidate",
    );
    assert.equal(
      readFileSync("/evidence/exchange-candidate", "utf8"),
      "active",
    );

    writeFileSync("/evidence/raced-candidate", "candidate", { mode: 0o600 });
    writeFileSync("/evidence/raced-active", "active", { mode: 0o600 });
    const racedCandidate = statSync("/evidence/raced-candidate", {
      bigint: true,
    });
    const racedActive = statSync("/evidence/raced-active", { bigint: true });
    renameSync("/evidence/raced-active", "/evidence/raced-retained");
    writeFileSync("/evidence/raced-active", "replacement", { mode: 0o600 });
    assert.equal(
      loader.exchangeOwnedFiles(exchangeDirectory, {
        sourceName: "raced-candidate",
        destinationName: "raced-active",
        sourceDevice: racedCandidate.dev.toString(),
        sourceInode: racedCandidate.ino.toString(),
        destinationDevice: racedActive.dev.toString(),
        destinationInode: racedActive.ino.toString(),
      }),
      "mismatch",
    );
    assert.equal(
      readFileSync("/evidence/raced-candidate", "utf8"),
      "candidate",
    );
    assert.equal(readFileSync("/evidence/raced-active", "utf8"), "replacement");
    assert.equal(readFileSync("/evidence/raced-retained", "utf8"), "active");
  } finally {
    closeSync(exchangeDirectory);
    for (const name of [
      "exchange-candidate",
      "exchange-active",
      "raced-candidate",
      "raced-active",
      "raced-retained",
    ])
      unlinkSync(`/evidence/${name}`);
  }
  writeFileSync("/evidence/recovery-fence-lock", "lock", { mode: 0o600 });
  const firstLockDescriptor = openSync(
    "/evidence/recovery-fence-lock",
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  const secondLockDescriptor = openSync(
    "/evidence/recovery-fence-lock",
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    assert.equal(loader.lockOwnedFile(firstLockDescriptor), "acquired");
    assert.equal(loader.lockOwnedFile(secondLockDescriptor), "busy");
    loader.unlockOwnedFile(firstLockDescriptor);
    assert.equal(loader.lockOwnedFile(secondLockDescriptor), "acquired");
    closeSync(secondLockDescriptor);
    const postCloseDescriptor = openSync(
      "/evidence/recovery-fence-lock",
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      assert.equal(loader.lockOwnedFile(postCloseDescriptor), "acquired");
      loader.unlockOwnedFile(postCloseDescriptor);
    } finally {
      closeSync(postCloseDescriptor);
    }
  } finally {
    loader.unlockOwnedFile(firstLockDescriptor);
    closeSync(firstLockDescriptor);
    try {
      closeSync(secondLockDescriptor);
    } catch {
      // The descriptor-close path above is the process-death-release analogue.
    }
    unlinkSync("/evidence/recovery-fence-lock");
  }
  writeFileSync("/evidence/recovery-fence-process-lock", "lock", {
    mode: 0o600,
  });
  const lockChild = spawn(
    process.execPath,
    [
      "-e",
      `
        const { constants, openSync } = require("node:fs");
        const loader = require("/work/node_modules/@agentscope/cli/dist/internal/local-sqlite/loader/owned-loader.cjs").load(Object.freeze({
          manifestDigest: process.argv[1],
          nativeTupleId: "node127-linux-x64-glibc",
          platformTupleId: "linux-x64-node22-ci-ext4-proposed",
        }));
        const descriptor = openSync("/evidence/recovery-fence-process-lock", constants.O_RDWR | constants.O_NOFOLLOW);
        if (loader.lockOwnedFile(descriptor) !== "acquired") process.exit(2);
        process.stdout.write("locked\\n");
        setInterval(() => {}, 1_000);
      `,
      manifestDigest,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lockChildOutput = createInterface({ input: lockChild.stdout });
  await within(
    new Promise((resolve, reject) => {
      lockChildOutput.once("line", (line) =>
        line === "locked"
          ? resolve(undefined)
          : reject(
              new Error("destination.local-sqlite.native-execution.invalid"),
            ),
      );
      lockChild.once("exit", (code) =>
        reject(
          new Error(
            `destination.local-sqlite.native-execution.invalid:${String(code)}`,
          ),
        ),
      );
    }),
    5_000,
  );
  const parentLockDescriptor = openSync(
    "/evidence/recovery-fence-process-lock",
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    assert.equal(loader.lockOwnedFile(parentLockDescriptor), "busy");
    lockChild.kill("SIGKILL");
    await within(
      new Promise((resolve) => lockChild.once("exit", resolve)),
      5_000,
    );
    assert.equal(loader.lockOwnedFile(parentLockDescriptor), "acquired");
    loader.unlockOwnedFile(parentLockDescriptor);
  } finally {
    lockChildOutput.close();
    lockChild.kill("SIGKILL");
    closeSync(parentLockDescriptor);
    unlinkSync("/evidence/recovery-fence-process-lock");
  }
  await executePackedReporterChild(loader);
  await executePackedRetrieverChild();

  let networkDenied = false;
  try {
    await fetch("http://198.51.100.1/native-egress-canary", {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    networkDenied = true;
  }
  if (!networkDenied)
    throw new Error("destination.local-sqlite.native-execution.invalid");
  let hostMutationDenied = false;
  try {
    writeFileSync("/host-canary", "mutated");
  } catch {
    hostMutationDenied = true;
  }
  if (!hostMutationDenied)
    throw new Error("destination.local-sqlite.native-execution.invalid");
  const retained = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  retained.unref();
})().catch((error) => {
  process.stderr.write(`${error?.message ?? "native execution failed"}\n`);
  process.exitCode = 1;
});
