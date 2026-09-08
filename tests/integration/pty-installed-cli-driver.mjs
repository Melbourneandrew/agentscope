import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { performance } from "node:perf_hooks";

import { executeSelectedPtyProcess } from "./testkit/headless-supervisor-kernel.js";
import { validateInstalledCliBoundary } from "./immutable-candidate-authority.mjs";

const installedBin = "/opt/agentscope/installed/node_modules/.bin/agentscope";
const installedCli =
  "/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js";
const installedPackage =
  "/opt/agentscope/installed/node_modules/agentscope-cli/package.json";
const predicates = new Set([
  "bin-authority",
  "cli-authority",
  "cli-boundary",
  "driver-input",
  "execution-rejected",
  "interpreter-authority",
  "package-authority",
  "package-manifest",
  "receipt-rejected",
]);
const proofs = new Set(["narrow-help", "version"]);
const fail = (predicate) => {
  if (!predicates.has(predicate))
    throw new Error("integration.pty-installed-cli-driver.driver-input");
  throw new Error(`integration.pty-installed-cli-driver.${predicate}`);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const authenticate = (path, maximumBytes, mode) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & 0o777) !== mode
    )
      return fail("cli-authority");
    const bytes = readFileSync(`/proc/self/fd/${descriptor}`);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      return fail("cli-authority");
    return Object.freeze({ bytes, sha256: sha256(bytes) });
  } finally {
    closeSync(descriptor);
  }
};
const fingerprint = (request) =>
  `sha256:${sha256(
    JSON.stringify({
      runId: request.runId,
      executable: request.executable,
      arguments: request.arguments,
      cwd: request.cwd,
      environment: request.environment,
      stdinBase64: Buffer.from(request.stdin).toString("base64"),
      stdoutLimitBytes: request.stdoutLimitBytes,
      stderrLimitBytes: request.stderrLimitBytes,
      monotonicStartupDeadlineMs: request.monotonicStartupDeadlineMs,
      monotonicExecutionDeadlineMs: request.monotonicExecutionDeadlineMs,
      monotonicShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
      terminationGraceMs: request.terminationGraceMs,
    }),
  )}`;
const proofConfiguration = (proof, version) => {
  if (proof === "version") {
    const bytes = Buffer.from(`${version}\r\n`);
    return Object.freeze({
      arguments: Object.freeze(["--version"]),
      outputBytes: bytes.length,
      outputSha256: sha256(bytes),
    });
  }
  if (proof === "narrow-help")
    return Object.freeze({
      arguments: Object.freeze(["--help"]),
      outputBytes: 1_182,
      outputSha256:
        "dd9b8aae571f7f55ead503a37bf6ebfe43848f96c2f91396ee19b50d98578639",
    });
  return fail("driver-input");
};
const validReceipt = (receipt, proof) =>
  receipt.outcome === "completed" &&
  receipt.exitCode === 0 &&
  receipt.signal === null &&
  receipt.isTTY === true &&
  JSON.stringify(receipt.initialGeometry) ===
    JSON.stringify({ columns: 40, rows: 12 }) &&
  JSON.stringify(receipt.observedGeometry) ===
    JSON.stringify({ columns: 40, rows: 12 }) &&
  receipt.outputBytes === proof.outputBytes &&
  receipt.outputSha256 === proof.outputSha256 &&
  receipt.cleanup === "clean" &&
  receipt.residualProcessCount === 0 &&
  receipt.processJoined === true &&
  receipt.terminalInputJoined === true &&
  receipt.terminalOutputJoined === true &&
  receipt.terminalTransportClosed === true;

export const runInstalledCliPtyProof = async ({
  capability,
  home,
  proof = "version",
  runId,
  shutdownDeadline,
}) => {
  if (
    typeof capability !== "object" ||
    capability === null ||
    typeof home !== "string" ||
    !home.startsWith("/") ||
    !proofs.has(proof) ||
    !/^[a-f0-9]{16}$/u.test(runId) ||
    !Number.isFinite(shutdownDeadline)
  )
    return fail("driver-input");
  let bin;
  let interpreter;
  let cli;
  try {
    bin = lstatSync(installedBin);
  } catch {
    return fail("bin-authority");
  }
  try {
    interpreter = authenticate(process.execPath, 256 * 1024 * 1024, 0o755);
  } catch {
    return fail("interpreter-authority");
  }
  try {
    cli = authenticate(installedCli, 16 * 1024 * 1024, 0o755);
  } catch {
    return fail("cli-authority");
  }
  try {
    const { arguments: arguments_ } = proofConfiguration(
      proof,
      "0.0.0-unverified",
    );
    validateInstalledCliBoundary({
      argv: [installedBin, ...arguments_],
      binIsSymlink: bin.isSymbolicLink(),
      binTarget: readlinkSync(installedBin),
      cliDigest: cli.sha256,
      cliMode: lstatSync(installedCli).mode & 0o777,
      cliPrefix: cli.bytes.subarray(0, 20).toString("utf8"),
      expectedDigest: cli.sha256,
    });
  } catch {
    return fail("cli-boundary");
  }
  let packageAuthority;
  try {
    packageAuthority = authenticate(installedPackage, 1024 * 1024, 0o644);
  } catch {
    return fail("package-authority");
  }
  let manifest;
  try {
    manifest = JSON.parse(packageAuthority.bytes.toString("utf8"));
  } catch {
    return fail("package-manifest");
  }
  if (
    manifest?.name !== "agentscope-cli" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest?.version) ||
    manifest?.bin?.agentscope !== "./dist/bin/agentscope.js"
  )
    return fail("package-manifest");
  const expected = proofConfiguration(proof, manifest.version);
  const now = performance.now();
  const processRequest = {
    runId,
    executable: installedCli,
    arguments: expected.arguments,
    cwd: "/opt/agentscope",
    environment: Object.freeze({ HOME: home, LANG: "C.UTF-8", NO_COLOR: "1" }),
    stdin: new Uint8Array(),
    stdoutLimitBytes: 4_096,
    stderrLimitBytes: 4_096,
    monotonicStartupDeadlineMs: Math.min(
      now + 10_000,
      shutdownDeadline - 5_000,
    ),
    monotonicExecutionDeadlineMs: shutdownDeadline - 5_000,
    monotonicShutdownDeadlineMs: shutdownDeadline,
    terminationGraceMs: 1_000,
  };
  processRequest.requestFingerprint = fingerprint(processRequest);
  let receipt;
  try {
    receipt = await executeSelectedPtyProcess(capability, {
      completion: {
        kind: "exact-output",
        outputBytes: expected.outputBytes,
        outputSha256: expected.outputSha256,
      },
      process: processRequest,
      initialGeometry: { columns: 40, rows: 12 },
      interpreter: { path: process.execPath, sha256: interpreter.sha256 },
      scriptSha256: cli.sha256,
    });
  } catch {
    return fail("execution-rejected");
  }
  if (!validReceipt(receipt, expected)) return fail("receipt-rejected");
  return Object.freeze({ proof, receipt, version: manifest.version });
};
