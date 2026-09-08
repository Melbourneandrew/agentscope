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

const installedBin = "/opt/agentscope/installed/bin/agentscope";
const installedCli =
  "/opt/agentscope/installed/node_modules/agentscope-cli/dist/bin/agentscope.js";
const installedPackage =
  "/opt/agentscope/installed/node_modules/agentscope-cli/package.json";
const fail = () => {
  throw new Error("integration.pty-installed-cli-driver");
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
      return fail();
    const bytes = readFileSync(`/proc/self/fd/${descriptor}`);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      return fail();
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

export const runInstalledCliPtyProof = async ({
  capability,
  home,
  runId,
  shutdownDeadline,
}) => {
  if (
    typeof capability !== "object" ||
    capability === null ||
    typeof home !== "string" ||
    !home.startsWith("/") ||
    !/^[a-f0-9]{16}$/u.test(runId) ||
    !Number.isFinite(shutdownDeadline)
  )
    return fail();
  const bin = lstatSync(installedBin);
  const interpreter = authenticate(process.execPath, 256 * 1024 * 1024, 0o755);
  const cli = authenticate(installedCli, 16 * 1024 * 1024, 0o755);
  validateInstalledCliBoundary({
    argv: [installedBin, "--version"],
    binIsSymlink: bin.isSymbolicLink(),
    binTarget: readlinkSync(installedBin),
    cliDigest: cli.sha256,
    cliMode: lstatSync(installedCli).mode & 0o777,
    cliPrefix: cli.bytes.subarray(0, 20).toString("utf8"),
    expectedDigest: cli.sha256,
  });
  const packageAuthority = authenticate(installedPackage, 1024 * 1024, 0o644);
  let manifest;
  try {
    manifest = JSON.parse(packageAuthority.bytes.toString("utf8"));
  } catch {
    return fail();
  }
  if (
    manifest?.name !== "agentscope-cli" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest?.version) ||
    manifest?.bin?.agentscope !== "./dist/bin/agentscope.js"
  )
    return fail();
  const expectedOutput = Buffer.from(`${manifest.version}\r\n`);
  const now = performance.now();
  const processRequest = {
    runId,
    executable: installedCli,
    arguments: ["--version"],
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
  const receipt = await executeSelectedPtyProcess(capability, {
    completion: {
      kind: "exact-output",
      outputBytes: expectedOutput.length,
      outputSha256: sha256(expectedOutput),
    },
    process: processRequest,
    initialGeometry: { columns: 40, rows: 12 },
    interpreter: { path: process.execPath, sha256: interpreter.sha256 },
    scriptSha256: cli.sha256,
  });
  if (
    receipt.outcome !== "completed" ||
    receipt.outputBytes !== expectedOutput.length ||
    receipt.outputSha256 !== sha256(expectedOutput) ||
    receipt.cleanup !== "clean" ||
    receipt.residualProcessCount !== 0 ||
    receipt.processJoined !== true ||
    receipt.terminalInputJoined !== true ||
    receipt.terminalOutputJoined !== true ||
    receipt.terminalTransportClosed !== true
  )
    return fail();
  return Object.freeze({ receipt, version: manifest.version });
};
