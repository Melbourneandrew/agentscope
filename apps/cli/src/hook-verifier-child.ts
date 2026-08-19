/* v8 ignore file -- this module executes only as a separately verified child. */
export type HookVerifierChildProgram = never;

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

const MAXIMUM_REQUEST_BYTES = 16_384;
const MAXIMUM_METADATA_BYTES = 16_384;
const MAXIMUM_LAUNCHER_BYTES = 65_536;
const launcherName =
  /^agentscope-hook-v1-([a-f0-9]{64})-d(50|[1-9][0-9]{2,4}|60000)$/u;
const harnessType = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const fail = (): never => {
  process.exitCode = 1;
  throw new Error("cli.hook.invalid");
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return fail();
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value])),
  );
};

const boundedFile = async (path: string, maximum: number): Promise<Buffer> => {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink()) return fail();
  const bytes = await readFile(path);
  if (bytes.byteLength > maximum) return fail();
  return bytes;
};

const main = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAXIMUM_REQUEST_BYTES) return fail();
    chunks.push(bytes);
  }
  const request = exactRecord(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    ["machineEntryPath", "nodeExecutable", "physicalPath", "releaseIdentity"],
  );
  if (
    typeof request.machineEntryPath !== "string" ||
    typeof request.nodeExecutable !== "string" ||
    typeof request.physicalPath !== "string" ||
    typeof request.releaseIdentity !== "string"
  )
    return fail();
  const physicalPath = await realpath(request.physicalPath);
  if (physicalPath !== request.physicalPath) return fail();
  const match = launcherName.exec(basename(physicalPath));
  if (!match) return fail();
  const information = await stat(physicalPath);
  if (!information.isFile() || (information.mode & 0o777) !== 0o700)
    return fail();
  const launcherBytes = await boundedFile(physicalPath, MAXIMUM_LAUNCHER_BYTES);
  const metadata = exactRecord(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedFile(
          `${physicalPath}.metadata.json`,
          MAXIMUM_METADATA_BYTES,
        ),
      ),
    ) as unknown,
    [
      "contractVersion",
      "harnessDigest",
      "harnessType",
      "hookDeadlineMilliseconds",
      "launcherPath",
      "launcherSha256",
      "machineEntryPath",
      "mode",
      "nodeExecutable",
      "releaseIdentity",
    ],
  );
  const duration = Number(match[2]);
  if (
    !Number.isSafeInteger(duration) ||
    duration < 50 ||
    duration > 60_000 ||
    metadata.contractVersion !== 1 ||
    typeof metadata.harnessType !== "string" ||
    !harnessType.test(metadata.harnessType) ||
    metadata.harnessDigest !== match[1] ||
    createHash("sha256").update(metadata.harnessType).digest("hex") !==
      match[1] ||
    metadata.hookDeadlineMilliseconds !== duration ||
    metadata.launcherPath !== physicalPath ||
    metadata.launcherSha256 !==
      createHash("sha256").update(launcherBytes).digest("hex") ||
    metadata.machineEntryPath !== request.machineEntryPath ||
    metadata.mode !== 0o700 ||
    metadata.nodeExecutable !== request.nodeExecutable ||
    metadata.releaseIdentity !== request.releaseIdentity ||
    dirname(dirname(physicalPath)).length === 0
  )
    return fail();
  process.stdout.write(
    `${JSON.stringify({
      duration,
      harnessType: metadata.harnessType,
      homeRoot: dirname(dirname(physicalPath)),
    })}\n`,
  );
};

void main().catch(() => {
  process.exitCode = 1;
});
