const reconciliationHints = Object.freeze({
  authority: "arm-pty-authority",
  observer: "arm-pty-observer",
  "observer-read": "arm-pty-observer-read",
  "observer-stat": "arm-pty-observer-stat",
  "observer-esrch": "arm-pty-observer-esrch",
  "observer-permission": "arm-pty-observer-permission",
  "observer-io": "arm-pty-observer-io",
  "observer-namespace": "arm-pty-observer-namespace",
  "observer-identity": "arm-pty-observer-identity",
  "observer-graph": "arm-pty-observer-graph",
  "observer-root-reuse": "arm-pty-observer-root-reuse",
  "observer-target-reuse": "arm-pty-observer-target-reuse",
  "observer-zombie-before": "arm-pty-observer-zombie-before",
  "observer-zombie-after": "arm-pty-observer-zombie-after",
  signal: "arm-pty-signal",
  reap: "arm-pty-reap",
  residual: "arm-pty-residual",
  "child-join": "arm-pty-child-join",
  "output-join": "arm-pty-output-join",
  "transport-close": "arm-pty-transport-close",
  "outer-shutdown": "arm-pty-outer-shutdown",
});

const receiptOutcomes = Object.freeze([
  "completed",
  "signaled",
  "exited-nonzero",
  "aborted",
  "timeout",
  "output-limit",
  "transport-failed",
  "input-incomplete",
]);
const checkpointCategories = Object.freeze([
  "not-requested",
  "no-live-readiness",
  "terminal-order-rejected",
  "terminal-reply-unsettled",
  "protocol-not-ready",
  "deadline",
  "ready-gate-other",
  "ready-gate-open",
  "topology-root-missing",
  "topology-nonroot-missing",
  "topology-identity-conflict",
  "publication-unsettled",
  "advanced",
]);

// Failure retention only. Copy two closed observations from an already parsed
// receipt, never its terminal text, identifiers, paths, timings or raw errors.
export const projectUntrustedCodexPtyReceipt = (receipt) => {
  try {
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      Object.getPrototypeOf(receipt) !== Object.prototype
    )
      return undefined;
    const outcome = Object.getOwnPropertyDescriptor(receipt, "outcome");
    const checkpoint = Object.getOwnPropertyDescriptor(
      receipt,
      "checkpointProgressDiagnostic",
    );
    if (
      !outcome ||
      !("value" in outcome) ||
      !receiptOutcomes.includes(outcome.value) ||
      (checkpoint &&
        (!("value" in checkpoint) ||
          !checkpointCategories.includes(checkpoint.value)))
    )
      return undefined;
    return Object.freeze({
      outcome: outcome.value,
      checkpointProgressDiagnostic: checkpoint?.value ?? null,
    });
  } catch {
    return undefined;
  }
};

export const validUntrustedCodexPtyReceipt = (value) => {
  if (value === null) return true;
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).sort().join("\0") !==
        "checkpointProgressDiagnostic\0outcome"
    )
      return false;
    const outcome = Object.getOwnPropertyDescriptor(value, "outcome");
    const checkpoint = Object.getOwnPropertyDescriptor(
      value,
      "checkpointProgressDiagnostic",
    );
    return (
      outcome !== undefined &&
      "value" in outcome &&
      receiptOutcomes.includes(outcome.value) &&
      checkpoint !== undefined &&
      "value" in checkpoint &&
      (checkpoint.value === null ||
        checkpointCategories.includes(checkpoint.value))
    );
  } catch {
    return false;
  }
};

export const codexPtyResearchHints = Object.freeze([
  "arm-pty-reconciliation",
  "arm-pty-startup",
  "arm-pty-transport",
  "arm-pty-kernel",
  "arm-pty-other",
  "arm-pty-before-call",
  "arm-pty-receipt-processing",
  "arm-pty-returned-failed",
  ...Object.values(reconciliationHints),
]);

// Research only, after selected execution has failed. The runner obtains the
// optional stage from the kernel's private error registry. Retained text is
// still candidate output: it never becomes terminal or admission authority.
export const codexArmPtyResearchHint = (error, stage) => {
  try {
    const message = error instanceof Error ? error.message : undefined;
    if (message === "testkit.headless.reconciliation.deadline")
      return typeof stage === "string" &&
        Object.hasOwn(reconciliationHints, stage)
        ? reconciliationHints[stage]
        : "arm-pty-reconciliation";
    if (message === "testkit.headless.startup.deadline")
      return "arm-pty-startup";
    if (typeof message === "string" && message.startsWith("testkit.pty."))
      return "arm-pty-transport";
    if (message === "testkit.headless.kernel.failure") return "arm-pty-kernel";
  } catch {
    // A hostile thrown value cannot suppress terminal failure evidence.
  }
  return "arm-pty-other";
};

export const extractUntrustedCodexPtyHint = (output) => {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024)
    return undefined;
  const lines = [
    ...output.matchAll(/^integration\.runner\.untrusted-pty-hint:[^\n]*$/gmu),
  ];
  if (lines.length !== 1) return undefined;
  const hint = lines[0]?.[0].match(
    /^integration\.runner\.untrusted-pty-hint:([a-z-]{1,32})$/u,
  )?.[1];
  return codexPtyResearchHints.includes(hint) ? hint : undefined;
};

// A post-failure, bounded and content-free snapshot only. The fixture's live
// SessionStart checkpoint remains the sole authority for model-gate arming.
export const failedCodexSessionStartHint = async (home) => {
  const directoryPath = join(home, ".codex", "diagnostic-log");
  let directoryDescriptor;
  try {
    directoryDescriptor = openSync(
      directoryPath,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    const directory = fstatSync(directoryDescriptor);
    if (
      !directory.isDirectory() ||
      directory.uid !== 1000 ||
      directory.gid !== 1000 ||
      (directory.mode & 0o7777) !== 0o700
    )
      return "arm-log-invalid";
    const { classifyCodexSessionStartAtFailedPty } =
      await import("./runtime/codex-runtime-evidence.mjs");
    return classifyCodexSessionStartAtFailedPty({
      directoryDescriptor,
      directoryPath,
    });
  } catch {
    return "arm-log-invalid";
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
};
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
