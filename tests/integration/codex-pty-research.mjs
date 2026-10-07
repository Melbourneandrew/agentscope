export {
  createCodexFailureResearchRecord,
  classifyCodexCollectedChildFailure,
  projectAdapterReportedFailure,
  encodeAdapterReportedFailureMarker,
  decodeAdapterReportedFailureMarker,
  extractAdapterReportedFailure,
} from "./codex-trace-child-diagnostics.mjs";
import {
  candidateConfigStages,
  extractUntrustedCodexConfigHint,
  codexFailureExitPair,
  extractAdapterReportedFailure,
  projectAdapterReportedFailure,
} from "./codex-trace-child-diagnostics.mjs";

export const validCodexResearchDiagnostic = (value) =>
  value === null ||
  (typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    [1, 2, 3, 4, 5, 6].includes(value.diagnosticVersion) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "diagnosticVersion",
          "exitPair",
          "untrustedConfigHint",
          ...(value.diagnosticVersion >= 2 ? ["untrustedGateHint"] : []),
          ...(value.diagnosticVersion >= 3 ? ["untrustedPtyHint"] : []),
          ...(value.diagnosticVersion >= 4 ? ["untrustedPtyReceipt"] : []),
          ...(value.diagnosticVersion >= 6 ? ["adapterReportedFailure"] : []),
        ].sort(),
      ) &&
    (value.untrustedConfigHint === null ||
      candidateConfigStages.includes(value.untrustedConfigHint)) &&
    (value.diagnosticVersion === 1 ||
      value.untrustedGateHint === null ||
      codexGateResearchHints.includes(value.untrustedGateHint)) &&
    (value.diagnosticVersion < 3 ||
      value.untrustedPtyHint === null ||
      codexPtyResearchHints.includes(value.untrustedPtyHint)) &&
    (value.diagnosticVersion < 4 ||
      validUntrustedCodexPtyReceipt(
        value.untrustedPtyReceipt,
        value.diagnosticVersion,
      )) &&
    (value.diagnosticVersion < 6 ||
      (() => {
        const observation = Object.getOwnPropertyDescriptor(
          value,
          "adapterReportedFailure",
        );
        return (
          observation !== undefined &&
          "value" in observation &&
          (observation.value === null ||
            projectAdapterReportedFailure(observation.value) !== undefined)
        );
      })()) &&
    (value.exitPair === null ||
      /^(?:none|(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])):(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/u.test(
        value.exitPair,
      )));
// This observer retains only the first fixed seal failure. It neither settles
// a request nor changes its signal, socket, error, or deadline authority.
export const createCodexModelControlRequest = ({
  httpRequest,
  agent,
  headers,
  socketPath,
  deadline,
  gateCutoff,
  now,
  observe,
}) => {
  let firstFailure;
  return (path, method, value, signal) => {
    const record = (hint) => {
      if (path !== "/seal" || firstFailure !== undefined) return;
      firstFailure = hint;
      try {
        observe?.(hint);
      } catch {
        /* Research cannot replace failure. */
      }
    };
    const operationDeadline =
      path === "/seal" || path === "/deny"
        ? deadline()
        : (gateCutoff() ?? deadline());
    const operationRemaining = Math.floor(operationDeadline - now());
    if (operationRemaining <= 0) {
      record("seal-deadline");
      throw new Error("integration.codex.model-gate-deadline");
    }
    const boundedSignal = AbortSignal.timeout(operationRemaining);
    const selectedSignal =
      signal === undefined
        ? boundedSignal
        : AbortSignal.any([signal, boundedSignal]);
    return new Promise((resolve, reject) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const request = httpRequest(
        {
          agent,
          headers:
            body === undefined
              ? headers
              : { ...headers, "content-length": Buffer.byteLength(body) },
          method,
          path,
          signal: selectedSignal,
          socketPath,
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.once("aborted", () => record("seal-response-aborted"));
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) {
              record("seal-response-limit");
              request.destroy();
            } else chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            try {
              if (response.statusCode !== 200) {
                record("seal-http-status");
                throw new Error("integration.codex.model-gate");
              }
              const decoded = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks, bytes),
                ),
              );
              resolve(decoded);
            } catch {
              record("seal-response-decode");
              reject(new Error("integration.codex.model-gate"));
            }
          });
        },
      );
      request.once("error", () => {
        record(
          selectedSignal.aborted ? "seal-signal-aborted" : "seal-transport",
        );
        reject(new Error("integration.codex.model-gate"));
      });
      request.end(body);
    });
  };
};

export const codexGateResearchHints = Object.freeze([
  "arm-log-unavailable",
  "arm-log-invalid",
  "arm-hook-unseen",
  "arm-hook-open",
  "arm-hook-completed",
  "arm-deadline",
  "arm-clock",
  "arm-phase",
  "arm-hook-log",
  "arm-hook-lifecycle",
  "arm-hook-mediation",
  "arm-session-missing",
  "arm-control",
  "arm-child",
  "arm-filesystem",
  "arm-other",
  "seal-deadline",
  "seal-request",
  "response-shape",
  "receipt-shape",
  "cutoff-unsettled",
  "state",
  "connection-count",
  "connection-shape",
  "admission",
  "connection-open",
  "generation",
  "parser-outcome",
  "parser-open",
  "raw-rejected",
  "transport-bytes",
  "ledger-count",
  "parser-failures",
  "mutation-generation",
  "identity",
  "ledger-shape",
  "other",
  "seal-transport",
  "seal-signal-aborted",
  "seal-http-status",
  "seal-response-decode",
  "seal-response-limit",
  "seal-response-aborted",
]);

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

const pumpOperations = Object.freeze([
  "read",
  "write",
  "emulator",
  "resize",
  "eof",
  "signal",
  "checkpoint-namespace",
  "checkpoint-freeze",
  "checkpoint-classify",
  "checkpoint-release",
  "checkpoint-publish",
  "pump-other",
]);
const pumpCategories = Object.freeze([
  "observer-read",
  "observer-identity",
  "transport",
  "geometry",
  "checkpoint-witness",
  "execution-deadline",
  "unknown",
]);
const projectPumpFailure = (value) => {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).sort().join("\0") !==
      "category\0operation\0originalExecutionDeadlineExhausted"
  )
    return undefined;
  const operation = Object.getOwnPropertyDescriptor(value, "operation");
  const category = Object.getOwnPropertyDescriptor(value, "category");
  const exhausted = Object.getOwnPropertyDescriptor(
    value,
    "originalExecutionDeadlineExhausted",
  );
  if (
    !operation ||
    !("value" in operation) ||
    !pumpOperations.includes(operation.value) ||
    !category ||
    !("value" in category) ||
    !pumpCategories.includes(category.value) ||
    !exhausted ||
    !("value" in exhausted) ||
    typeof exhausted.value !== "boolean"
  )
    return undefined;
  return Object.freeze({
    operation: operation.value,
    category: category.value,
    originalExecutionDeadlineExhausted: exhausted.value,
  });
};

// Failure retention only. Copy two closed observations from an already parsed
// receipt, never its terminal text, identifiers, paths, timings or raw errors.
export const projectUntrustedCodexPtyReceipt = (
  receipt,
  diagnosticVersion = 4,
) => {
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
    const pumpDescriptor =
      diagnosticVersion >= 5
        ? Object.getOwnPropertyDescriptor(receipt, "pumpFailureDiagnostic")
        : undefined;
    if (pumpDescriptor && !("value" in pumpDescriptor)) return undefined;
    const pumpFailureDiagnostic = projectPumpFailure(pumpDescriptor?.value);
    if (diagnosticVersion >= 5 && pumpFailureDiagnostic === undefined)
      return undefined;
    return Object.freeze({
      outcome: outcome.value,
      checkpointProgressDiagnostic: checkpoint?.value ?? null,
      ...(diagnosticVersion >= 5 ? { pumpFailureDiagnostic } : {}),
    });
  } catch {
    return undefined;
  }
};

export const validUntrustedCodexPtyReceipt = (value, diagnosticVersion = 4) => {
  if (value === null) return true;
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).sort().join("\0") !==
        (diagnosticVersion >= 5
          ? "checkpointProgressDiagnostic\0outcome\0pumpFailureDiagnostic"
          : "checkpointProgressDiagnostic\0outcome")
    )
      return false;
    const outcome = Object.getOwnPropertyDescriptor(value, "outcome");
    const checkpoint = Object.getOwnPropertyDescriptor(
      value,
      "checkpointProgressDiagnostic",
    );
    const pump =
      diagnosticVersion >= 5
        ? Object.getOwnPropertyDescriptor(value, "pumpFailureDiagnostic")
        : undefined;
    return (
      (diagnosticVersion < 5 ||
        (pump !== undefined &&
          "value" in pump &&
          pump.value !== undefined &&
          projectPumpFailure(pump.value) !== undefined)) &&
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

export const extractUntrustedCodexGateHint = (output) => {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024)
    return undefined;
  const lines = [
    ...output.matchAll(/^integration\.runner\.untrusted-gate-hint:[^\n]*$/gmu),
  ];
  if (lines.length !== 1) return undefined;
  const hint = lines[0]?.[0].match(
    /^integration\.runner\.untrusted-gate-hint:([a-z-]{1,32})$/u,
  )?.[1];
  return codexGateResearchHints.includes(hint) ? hint : undefined;
};

export const codexResearchDependencies = Object.freeze([
  extractUntrustedCodexConfigHint,
  extractUntrustedCodexGateHint,
  extractUntrustedCodexPtyHint,
  projectUntrustedCodexPtyReceipt,
  extractAdapterReportedFailure,
  codexFailureExitPair,
]);
