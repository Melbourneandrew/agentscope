/* v8 ignore file -- this process entry is executed causally from the clean-installed packed CLI by the native-candidate verifier. */
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import { LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST } from "../native-support.js";
import type {
  LocalSqliteGetPlan,
  LocalSqliteSearchPlan,
} from "../retriever/index.js";
import { currentProcessStartIdentity } from "./filesystem-port.js";
import {
  openOwnedSqliteDescriptor,
  type OwnedSqliteOpener,
} from "./lifecycle-port.js";
import {
  inspectOwnedSqliteFamily,
  openOwnedDirectory,
  openOwnedFile,
  type OwnedFile,
} from "./owned-filesystem.js";
import {
  decodeLocalSqliteReporterChildPermission,
  encodeLocalSqliteReporterChildMessage,
} from "./reporter-child-protocol.js";
import {
  decodeLocalSqliteRetrieverChildRequest,
  encodeLocalSqliteRetrieverChildResult,
  MAXIMUM_RETRIEVER_CHILD_REQUEST_BYTES,
  type LocalSqliteRetrieverChildRequest,
  type LocalSqliteRetrieverChildResult,
} from "./retriever-child-protocol.js";
import {
  createOwnedRetrieverDatabase,
  initializeOwnedSqliteConnection,
} from "./sqlite-port.js";

type Loader = Readonly<{
  load: (
    authority: Readonly<{
      manifestDigest: string;
      nativeTupleId: string;
      platformTupleId: string;
    }>,
  ) => OwnedSqliteOpener;
}>;

const fail = (): never => {
  process.exit(70);
};

type SqliteFamily = ReturnType<typeof inspectOwnedSqliteFamily>;

const sameFamily = (expected: SqliteFamily, observed: SqliteFamily): boolean =>
  expected.length === observed.length &&
  expected.every(
    ({ name, evidence }, index) =>
      observed[index]?.name === name &&
      observed[index]?.evidence.physicalIdentity === evidence.physicalIdentity,
  );

const admittedFinalFamily = (
  expected: SqliteFamily,
  observed: SqliteFamily,
): boolean =>
  observed.every(({ name, evidence }) => {
    const prior = expected.find((entry) => entry.name === name);
    return prior?.evidence.physicalIdentity === evidence.physicalIdentity;
  });

const readLines = (): Readonly<{
  request: Promise<LocalSqliteRetrieverChildRequest>;
  permission: Promise<string>;
}> => {
  let buffer = Buffer.alloc(0);
  let requestValue: LocalSqliteRetrieverChildRequest | undefined;
  let sawPermission = false;
  let resolveRequest!: (value: LocalSqliteRetrieverChildRequest) => void;
  let resolvePermission!: (value: string) => void;
  const request = new Promise<LocalSqliteRetrieverChildRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const permission = new Promise<string>((resolve) => {
    resolvePermission = resolve;
  });
  process.stdin.on("data", (value: Buffer | Uint8Array) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    buffer = Buffer.concat([buffer, chunk]);
    const maximum =
      requestValue === undefined ? MAXIMUM_RETRIEVER_CHILD_REQUEST_BYTES : 256;
    if (buffer.byteLength > maximum) fail();
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      if (requestValue === undefined) {
        requestValue = decodeLocalSqliteRetrieverChildRequest(line);
        if (requestValue === undefined) return fail();
        resolveRequest(requestValue);
        continue;
      }
      sawPermission = true;
      process.stdin.pause();
      resolvePermission(line);
      if (buffer.byteLength !== 0) fail();
      return;
    }
  });
  const failOnPrematurePipeLoss = (): void => {
    if (!sawPermission) fail();
  };
  process.stdin.on("end", failOnPrematurePipeLoss);
  process.stdin.on("close", failOnPrematurePipeLoss);
  return Object.freeze({ request, permission });
};

// eslint-disable-next-line max-lines-per-function -- the isolated child owns one closed request/permission/native/settlement ledger.
const main = async (): Promise<void> => {
  const input = readLines();
  const request = await input.request;
  const expiresAt = performance.now() + request.maximumWorkMilliseconds;
  process.stdout.write(
    encodeLocalSqliteReporterChildMessage({
      type: "ready",
      nonce: request.nonce,
      pid: process.pid,
      startIdentity: currentProcessStartIdentity(),
    }),
  );
  const permission = decodeLocalSqliteReporterChildPermission(
    await input.permission,
  );
  if (permission?.nonce !== request.nonce || performance.now() >= expiresAt)
    return fail();
  let result: LocalSqliteRetrieverChildResult = Object.freeze({
    type: "retrieval-result",
    nonce: request.nonce,
    ok: false,
  });
  let database: ReturnType<OwnedSqliteOpener["open"]> | undefined;
  let directory: ReturnType<typeof openOwnedDirectory> | undefined;
  let databaseFile: OwnedFile | undefined;
  let admittedFamily: SqliteFamily | undefined;
  try {
    const loaderUrl = new URL(
      "../local-sqlite/loader/owned-loader.cjs",
      import.meta.url,
    );
    const loader = createRequire(import.meta.url)(
      fileURLToPath(loaderUrl),
    ) as Loader;
    const opener = loader.load({
      manifestDigest: LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST,
      nativeTupleId: "node127-linux-x64-glibc",
      platformTupleId: "linux-x64-node22-ci-ext4-proposed",
    });
    const remaining = (): number => Math.floor(expiresAt - performance.now());
    if (remaining() < 1) return fail();
    directory = openOwnedDirectory(dirname(request.databasePath));
    const databaseName = basename(request.databasePath);
    const matchesRequest = (
      observed: ReturnType<typeof inspectOwnedSqliteFamily>,
    ): boolean =>
      observed.length === request.databaseFamily.length &&
      observed.every(
        ({ name, evidence }, index) =>
          request.databaseFamily[index]?.name === name &&
          request.databaseFamily[index]?.physicalIdentity ===
            evidence.physicalIdentity,
      );
    const preservesRequest = (
      observed: ReturnType<typeof inspectOwnedSqliteFamily>,
    ): boolean =>
      request.databaseFamily.every((expected) => {
        const current = observed.find(({ name }) => name === expected.name);
        return current?.evidence.physicalIdentity === expected.physicalIdentity;
      });
    if (
      !matchesRequest(
        inspectOwnedSqliteFamily(
          directory,
          databaseName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        ),
      )
    )
      return fail();
    databaseFile = openOwnedFile(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      { requireNonempty: true },
    );
    database = openOwnedSqliteDescriptor(
      opener,
      databaseFile,
      { fileMustExist: true, readonly: true, timeout: remaining() },
      false,
    );
    if (
      !preservesRequest(
        inspectOwnedSqliteFamily(
          directory,
          databaseName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        ),
      ) ||
      remaining() < 1
    )
      return fail();
    initializeOwnedSqliteConnection(database, remaining());
    admittedFamily = inspectOwnedSqliteFamily(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    if (!preservesRequest(admittedFamily)) return fail();
    const retriever = createOwnedRetrieverDatabase(
      database,
      request.policy,
      remaining,
    );
    const signal = new AbortController().signal;
    const evidence =
      request.operation === "search"
        ? await retriever.search(request.plan as LocalSqliteSearchPlan, signal)
        : await retriever.get(request.plan as LocalSqliteGetPlan, signal);
    if (
      remaining() < 1 ||
      !sameFamily(
        admittedFamily,
        inspectOwnedSqliteFamily(
          directory,
          databaseName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        ),
      )
    )
      return fail();
    result = Object.freeze({
      type: "retrieval-result",
      nonce: request.nonce,
      ok: true,
      evidence,
    });
  } catch {
    // The parent and family retriever map this fixed result conservatively.
  }
  try {
    database?.close();
    databaseFile?.assertCurrent();
    if (
      directory !== undefined &&
      databaseFile !== undefined &&
      admittedFamily !== undefined &&
      !admittedFinalFamily(
        admittedFamily,
        inspectOwnedSqliteFamily(
          directory,
          basename(request.databasePath),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        ),
      )
    )
      result = Object.freeze({
        type: "retrieval-result",
        nonce: request.nonce,
        ok: false,
      });
  } catch {
    result = Object.freeze({
      type: "retrieval-result",
      nonce: request.nonce,
      ok: false,
    });
  }
  try {
    databaseFile?.close();
    directory?.assertCurrent();
    directory?.close();
  } catch {
    result = Object.freeze({
      type: "retrieval-result",
      nonce: request.nonce,
      ok: false,
    });
  }
  process.stdout.write(encodeLocalSqliteRetrieverChildResult(result));
};

void main().catch(() => {
  process.exitCode = 70;
});
