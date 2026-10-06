import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const MAXIMUM_TARGET_BYTES = 1_048_576;
/* v8 ignore next -- every supported Node platform exposes O_NOFOLLOW. */
const noFollow = constants.O_NOFOLLOW ?? 0;
const readFlags = constants.O_RDONLY | noFollow | constants.O_NONBLOCK;
const emptyDigest = createHash("sha256").update("").digest("hex");

export type FileSnapshot = Readonly<{
  exists: boolean;
  bytes: Uint8Array | null;
  digest: string;
  mode: number | null;
}>;

export const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

export const inspectInstallationPreimage = async (
  path: string,
  invalid: () => never,
): Promise<FileSnapshot> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, readFlags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return invalid();
    if (metadata.size > MAXIMUM_TARGET_BYTES) return invalid();
    const buffer = Buffer.alloc(MAXIMUM_TARGET_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    /* v8 ignore next -- the pre-read metadata cap handles stable files; this
       guard catches an external growth race without allocating past max+1. */
    if (offset > MAXIMUM_TARGET_BYTES) return invalid();
    const bytes = new Uint8Array(buffer.subarray(0, offset));
    return Object.freeze({
      exists: true,
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      mode: metadata.mode & 0o777,
    });
  } catch (error) {
    /* v8 ignore next -- admission rejects links; this contains a link swapped
       into place during the subsequent target-inspection race. */
    if (nodeErrorCode(error) === "ELOOP") return invalid();
    if (nodeErrorCode(error) === "ENOENT")
      return Object.freeze({
        exists: false,
        bytes: null,
        digest: emptyDigest,
        mode: null,
      });
    throw error;
  } finally {
    await handle?.close();
  }
};

export const snapshotMatches = (
  snapshot: FileSnapshot,
  exists: boolean,
  digest: string,
) => snapshot.exists === exists && snapshot.digest === digest;

export const snapshotMatchesManifestState = (
  snapshot: FileSnapshot,
  exists: boolean,
  digest: string,
  mode: number | null,
): boolean =>
  snapshotMatches(snapshot, exists, digest) && snapshot.mode === mode;
