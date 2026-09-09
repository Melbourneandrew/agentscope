import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";

const MAXIMUM_BYTES = 1024 * 1024;
const ARTIFACT_PATCH_SHA256 =
  "9638aca3637f07d89c766e49c1719eb2f58a20b1165da4962ea755e9032c392b";
const PATCHED_ARTIFACT_FILES = Object.freeze({
  "path-and-artifact-name-validation.js":
    "6ce71a90c3abefd252265b4bad1dc38fe3980014d11fca8a240596615d99a6d4",
  "stream.js":
    "5eeaefb718a18cc6ac399c3433348d84e1c26af50d3c3defbb92cf05d988f96a",
  "upload-artifact.js":
    "f4936f8c7119371f65f08d7bce855458ea6c9476febfa56a0e289a454bb5427e",
  "zip.js": "4bd1967f092499689cd0e26d116a3ad1a138dc27ac2d87adb2493697a3ac2adc",
});
const ARTIFACT_ENTRY_SHA256 =
  "767d73362f34cc323231b614434fa93967110fdd7a7aa807b1a1d2b03a572cd0";
const ARTIFACT_PACKAGE_SHA256 =
  "e21bb31fa8424754cd03c72278d78a76e50429895a9cb2babf69b4a7ba8f533a";
const fail = () => {
  throw new Error("integration.controller.failure-evidence-upload");
};
const parseUnsigned = (value, maximum) => {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) fail();
  return parsed;
};
const parseDeadline = (value) => {
  if (!/^[1-9]\d{0,18}$/u.test(value ?? "")) fail();
  const parsed = BigInt(value);
  if (parsed > 2n ** 63n - 1n) fail();
  return parsed;
};
const exactArguments = (arguments_) => {
  if (arguments_.length !== 12) fail();
  const expected = [
    "--fd",
    "--size",
    "--digest",
    "--name",
    "--deadline",
    "--python",
  ];
  const values = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (arguments_[index * 2] !== expected[index]) fail();
    values[expected[index].slice(2)] = arguments_[index * 2 + 1];
  }
  return values;
};
const processStartTicks = () => {
  const content = Buffer.alloc(4097);
  const descriptor = openSync(
    "/proc/self/stat",
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const count = readSync(descriptor, content, 0, content.length, 0);
    if (count < 1 || count > 4096) fail();
    const record = content.subarray(0, count).toString("ascii");
    const close = record.lastIndexOf(") ");
    const fields = record
      .slice(close + 2)
      .trim()
      .split(" ");
    if (close < 2 || fields.length < 20 || !/^[1-9]\d*$/u.test(fields[19]))
      fail();
    return fields[19];
  } finally {
    closeSync(descriptor);
  }
};
const readExact = (descriptor, size) => {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, content, offset, size - offset, offset);
    if (count < 1) fail();
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, size) !== 0) fail();
  return content;
};
const closedClient = (client) => {
  const uploadArtifact = client.uploadArtifact;
  if (typeof uploadArtifact !== "function") fail();
  return Object.freeze({ uploadArtifact: uploadArtifact.bind(client) });
};
const verifyRegularDigest = (path, expected, maximum) => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.size < 1 ||
      status.size > maximum
    )
      fail();
    const content = readFileSync(descriptor);
    if (
      content.length !== status.size ||
      createHash("sha256").update(content).digest("hex") !== expected
    )
      fail();
  } finally {
    closeSync(descriptor);
  }
};
const resolveArtifactClientEntry = (workspace) => {
  const packageRoot = realpathSync(
    resolve(workspace, "tests/integration/node_modules/@actions/artifact"),
  );
  if (
    !packageRoot.includes("/@actions+artifact@6.2.1_patch_hash=") ||
    !packageRoot.endsWith("/node_modules/@actions/artifact")
  )
    fail();
  verifyRegularDigest(
    resolve(packageRoot, "package.json"),
    ARTIFACT_PACKAGE_SHA256,
    64 * 1024,
  );
  const entry = resolve(packageRoot, "lib/artifact.js");
  verifyRegularDigest(entry, ARTIFACT_ENTRY_SHA256, 64 * 1024);
  const uploadRoot = resolve(packageRoot, "lib/internal/upload");
  for (const [name, digest] of Object.entries(PATCHED_ARTIFACT_FILES))
    verifyRegularDigest(resolve(uploadRoot, name), digest, 64 * 1024);
};
const verifyArtifactClientProvenance = () => {
  if (
    Object.keys(process.env).sort().join("\n") !==
    [
      "ACTIONS_RESULTS_URL",
      "ACTIONS_RUNTIME_TOKEN",
      "GITHUB_SERVER_URL",
      "GITHUB_WORKSPACE",
    ].join("\n")
  )
    fail();
  const workspace = process.env.GITHUB_WORKSPACE;
  if (typeof workspace !== "string" || !workspace.startsWith("/")) fail();
  verifyRegularDigest(
    resolve(workspace, "patches/@actions__artifact@6.2.1.patch"),
    ARTIFACT_PATCH_SHA256,
    64 * 1024,
  );
  resolveArtifactClientEntry(workspace);
};

const uploadFailureEvidenceImplementation = async ({
  arguments_,
  client,
  nowNanoseconds,
  probe,
  startTicks = processStartTicks,
}) => {
  const values = exactArguments(arguments_);
  const descriptor = parseUnsigned(values.fd, 2 ** 20);
  const size = parseUnsigned(values.size, MAXIMUM_BYTES);
  const deadline = parseDeadline(values.deadline);
  const admission = nowNanoseconds();
  if (
    deadline <= admission ||
    deadline > admission + 20n * 60n * 1_000_000_000n
  )
    fail();
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(values.digest) ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(values.name) ||
    !values.python.startsWith("/")
  )
    fail();
  const status = fstatSync(descriptor);
  if (
    !status.isFile() ||
    status.size !== size ||
    (status.mode & 0o7777) !== 0o400
  )
    fail();
  const content = readExact(descriptor, size);
  if (
    `sha256:${createHash("sha256").update(content).digest("hex")}` !==
    values.digest
  )
    fail();
  const start = startTicks();
  await probe([
    values.python,
    "probe",
    String(process.pid),
    String(descriptor),
    String(size),
    values.digest,
    start,
  ]);
  const authority = closedClient(client);
  const response = await authority.uploadArtifact(
    values.name,
    [`/proc/self/fd/${descriptor}`],
    "/proc/self/fd",
    Object.freeze({ compressionLevel: 0, retentionDays: 7 }),
  );
  if (deadline <= nowNanoseconds()) fail();
  await probe([
    values.python,
    "probe",
    String(process.pid),
    String(descriptor),
    String(size),
    values.digest,
    start,
  ]);
  if (
    !Number.isSafeInteger(response.id) ||
    response.id < 1 ||
    !Number.isSafeInteger(response.size) ||
    response.size < 1 ||
    !/^[a-f0-9]{64}$/u.test(response.digest ?? "")
  )
    fail();
  return Object.freeze({
    artifactDigest: `sha256:${response.digest}`,
    artifactId: response.id,
    artifactSize: response.size,
    status: "uploaded",
  });
};

export const uploadFailureEvidence = async (options) => {
  try {
    return await uploadFailureEvidenceImplementation(options);
  } catch {
    fail();
  }
};

const main = async () => {
  const arguments_ = process.argv.slice(1);
  const values = exactArguments(arguments_);
  const descriptor = parseUnsigned(values.fd, 2 ** 20);
  const probe = async (arguments_) => {
    const result = spawnSync(arguments_[0], arguments_.slice(1), {
      env: {},
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      result.signal !== null ||
      result.stderr.length !== 0 ||
      result.stdout.toString("utf8") !== '{"status":"authenticated"}\n'
    )
      fail();
  };
  let receipt;
  try {
    verifyArtifactClientProvenance();
    const { DefaultArtifactClient } = await import("@actions/artifact");
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    receipt = await uploadFailureEvidence({
      arguments_,
      client: new DefaultArtifactClient(),
      nowNanoseconds: process.hrtime.bigint,
      probe,
    });
    process.stdout.write = originalWrite;
    originalWrite(`${JSON.stringify(receipt)}\n`);
  } finally {
    closeSync(descriptor);
  }
};

if (process.argv[1] === "--fd") {
  main().catch(() => {
    process.exitCode = 1;
  });
}
