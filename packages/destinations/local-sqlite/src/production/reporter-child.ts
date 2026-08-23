/* v8 ignore file -- this process entry is executed causally from the clean-installed packed CLI by the native-candidate verifier. */
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReporterReceipt,
  type ReporterReceipt,
} from "@agentscope/destinations-core";

import { executePreparedLocalSqliteTransaction } from "../reporter/transaction.js";
import { LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST } from "../native-support.js";
import {
  createOwnedReporterDatabase,
  initializeOwnedSqliteConnection,
} from "./sqlite-port.js";
import {
  openOwnedSqliteDescriptor,
  type OwnedSqliteOpener,
} from "./lifecycle-port.js";
import { currentProcessStartIdentity } from "./filesystem-port.js";
import {
  inspectOwnedSqliteFamily,
  openOwnedDirectory,
  openOwnedFile,
  type OwnedFile,
} from "./owned-filesystem.js";
import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import {
  decodeLocalSqliteReporterChildPermission,
  decodeLocalSqliteReporterChildRequestHeader,
  decodeLocalSqliteReporterChildTrace,
  encodeLocalSqliteReporterChildMessage,
  localSqliteReporterChildBatchFits,
  MAXIMUM_REPORTER_CHILD_HEADER_BYTES,
  MAXIMUM_REPORTER_CHILD_REQUEST_BYTES,
  MAXIMUM_REPORTER_CHILD_TRACE_BYTES,
  type LocalSqliteReporterChildRequest,
  type LocalSqliteReporterChildRequestHeader,
} from "./reporter-child-protocol.js";

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
  process.exitCode = 70;
  throw new Error("destination.local-sqlite.child.invalid");
};

const write = (
  value: Parameters<typeof encodeLocalSqliteReporterChildMessage>[0],
): void => {
  process.stdout.write(encodeLocalSqliteReporterChildMessage(value));
};

// eslint-disable-next-line max-lines-per-function -- the isolated child owns one closed request/permission/native/settlement ledger.
const main = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let requestBytes = 0;
  let header: LocalSqliteReporterChildRequestHeader | undefined;
  const prepared: LocalSqliteReporterChildRequest["prepared"][number][] = [];
  let sawPermission = false;
  let resolvePermission: ((line: string) => void) | undefined;
  const permission = new Promise<string>((resolve) => {
    resolvePermission = resolve;
  });
  const maximumLineBytes = (): number =>
    header === undefined
      ? MAXIMUM_REPORTER_CHILD_HEADER_BYTES
      : prepared.length < header.preparedCount
        ? MAXIMUM_REPORTER_CHILD_TRACE_BYTES
        : 256;
  const acceptLine = (lineBytes: Buffer): void => {
    const line = lineBytes.toString("utf8");
    if (header === undefined) {
      header = decodeLocalSqliteReporterChildRequestHeader(line);
      if (header === undefined) fail();
      return;
    }
    if (prepared.length < header.preparedCount) {
      const trace = decodeLocalSqliteReporterChildTrace(
        line,
        header.nonce,
        header.admissionTimeUnixNano,
      );
      if (trace === undefined) return fail();
      prepared.push(trace);
      if (!localSqliteReporterChildBatchFits(prepared)) fail();
      if (prepared.length === header.preparedCount) {
        if (
          new Set(prepared.map((value) => value.deliveryIdentity)).size !==
          prepared.length
        )
          fail();
        write({
          type: "ready",
          nonce: header.nonce,
          pid: process.pid,
          startIdentity: currentProcessStartIdentity(),
        });
      }
      return;
    }
    if (sawPermission) fail();
    sawPermission = true;
    process.stdin.pause();
    resolvePermission?.(line);
  };
  process.stdin.on("data", (chunkValue: Buffer | Uint8Array) => {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const piece = chunk.subarray(offset, end);
      bytes += piece.byteLength;
      requestBytes += piece.byteLength + (newline < 0 ? 0 : 1);
      if (
        bytes > maximumLineBytes() ||
        requestBytes > MAXIMUM_REPORTER_CHILD_REQUEST_BYTES ||
        chunks.length >= 4_096
      )
        fail();
      if (piece.byteLength > 0) chunks.push(piece);
      if (newline < 0) return;
      const lineBytes = Buffer.concat(chunks, bytes);
      chunks.length = 0;
      bytes = 0;
      acceptLine(lineBytes);
      offset = newline + 1;
    }
  });
  while (header === undefined || prepared.length !== header.preparedCount)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const request: LocalSqliteReporterChildRequest = Object.freeze({
    type: "attempt",
    nonce: header.nonce,
    databasePath: header.databasePath,
    databaseFamily: header.databaseFamily,
    maximumWorkMilliseconds: header.maximumWorkMilliseconds,
    policy: header.policy,
    prepared: Object.freeze(prepared),
    admissionTimeUnixNano: header.admissionTimeUnixNano,
  });
  const expiresAt = performance.now() + request.maximumWorkMilliseconds;
  const permissionRecord = decodeLocalSqliteReporterChildPermission(
    await permission,
  );
  if (
    permissionRecord?.nonce !== request.nonce ||
    performance.now() >= expiresAt
  )
    return fail();
  let receipt: ReporterReceipt;
  let database: ReturnType<OwnedSqliteOpener["open"]> | undefined;
  let directory: ReturnType<typeof openOwnedDirectory> | undefined;
  let databaseFile: OwnedFile | undefined;
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
    const remainingBeforeOpen = Math.floor(expiresAt - performance.now());
    if (remainingBeforeOpen < 1) throw new Error("child budget exhausted");
    directory = openOwnedDirectory(dirname(request.databasePath));
    const databaseName = basename(request.databasePath);
    const before = inspectOwnedSqliteFamily(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
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
    if (!matchesRequest(before)) return fail();
    databaseFile = openOwnedFile(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      { writable: true, requireNonempty: true },
    );
    database = openOwnedSqliteDescriptor(
      opener,
      databaseFile,
      { fileMustExist: true, timeout: remainingBeforeOpen },
      false,
    );
    const opened = inspectOwnedSqliteFamily(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    if (!matchesRequest(opened)) return fail();
    const remainingAfterOpen = Math.floor(expiresAt - performance.now());
    if (remainingAfterOpen < 1)
      throw new Error("child budget exhausted after open");
    initializeOwnedSqliteConnection(database, remainingAfterOpen);
    receipt = executePreparedLocalSqliteTransaction(
      createOwnedReporterDatabase(database),
      request.policy,
      request.prepared,
      request.admissionTimeUnixNano,
      () => performance.now() >= expiresAt,
    );
    const after = inspectOwnedSqliteFamily(
      directory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    if (!preservesRequest(after))
      receipt = createReporterReceipt("outcome-unknown");
  } catch {
    receipt = createReporterReceipt("outcome-unknown");
  }
  try {
    database?.close();
    databaseFile?.assertCurrent();
  } catch {
    receipt = createReporterReceipt("outcome-unknown");
  }
  try {
    databaseFile?.close();
    directory?.assertCurrent();
    directory?.close();
  } catch {
    receipt = createReporterReceipt("outcome-unknown");
  }
  write({ type: "result", nonce: request.nonce, receipt });
};

void main().catch(() => {
  process.exitCode = 70;
});
