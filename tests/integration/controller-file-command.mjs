/** Optional research diagnostics, never controller or retirement authority. */
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { types } from "node:util";

const stages = [
  "unknown",
  "clean",
  "maintainArtifacts",
  "prepareCandidate",
  "prepareImages",
  "prepareModelRoutes",
  "runScenarios",
  "select",
];
const signals = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGHUP",
  "SIGQUIT",
  "SIGPIPE",
];
const materialPhases = [
  "research-preflight",
  "research-client",
  "research-inventory",
  "research-close",
  "bootstrap-preflight",
  "download-source",
  "download-maven",
  "download-node",
  "download-jdk",
  "verify-archives",
  "pinned-metadata",
  "download-maven-key",
  "download-maven-signature",
  "verify-maven",
  "verify-node",
  "verify-jdk",
  "retire-maven",
  "retire-node",
  "retire-jdk",
  "bootstrap-cleanup",
  "supplier-context",
  "supplier-build",
  "supplier-inventory",
  "supplier-cleanup",
];
const own = (value, key) => {
  if (typeof value !== "object" || value === null || types.isProxy(value))
    return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
};
const selected = (value, allowed) =>
  allowed.includes(value) ? value : "unknown";
const boolean = (value) =>
  typeof value === "boolean" ? String(value) : "unknown";
const status = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 255
    ? String(value)
    : "unknown";

const append = (fields, environment) => {
  let descriptor;
  try {
    if (own(environment, "AGENTSCOPE_MOCKSERVER_RESEARCH") !== "supplier")
      return;
    const target = own(environment, "GITHUB_OUTPUT");
    if (
      typeof target !== "string" ||
      target.length > 4096 ||
      !isAbsolute(target) ||
      /[\0\r\n]/u.test(target)
    )
      return;
    const bytes = Buffer.from(
      fields.map(([key, value]) => `${key}=${value}\n`).join(""),
    );
    if (bytes.length > 1024) return;
    descriptor = openSync(
      target,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    if (!fstatSync(descriptor).isFile()) return;
    writeSync(descriptor, bytes);
  } catch {
    // A missing diagnostic cannot change the original execution disposition.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Optional sink only. */
      }
    }
  }
};

export const publishSupervisorObservation = (
  result,
  environment = process.env,
) => {
  append(
    [
      [
        "supervisor_observation",
        result === undefined ? "rejected" : "terminal",
      ],
      ["supervisor_code", status(own(result, "code"))],
      [
        "supervisor_signal",
        own(result, "signal") === null
          ? "none"
          : selected(own(result, "signal"), signals),
      ],
      ["supervisor_contained", boolean(own(result, "contained"))],
      ["supervisor_residual", boolean(own(result, "residualWorkObserved"))],
      ["supervisor_termination", boolean(own(result, "terminationInitiated"))],
      [
        "supervisor_within_deadline",
        boolean(own(result, "completedWithinDeadline")),
      ],
    ],
    environment,
  );
};

/** Last entered work step only; never success, cleanup or acquisition evidence. */
export const publishMaterialResearchPhase = (
  phase,
  environment = process.env,
) => {
  append([["material_phase", selected(phase, materialPhases)]], environment);
};

export const publishControllerFailureObservation = (
  diagnostic,
  environment = process.env,
) => {
  const image = own(diagnostic, "imagePreparation");
  append(
    [
      [
        "controller_failure",
        selected(own(diagnostic, "failure"), [
          "integration.controller.failed",
          "integration.controller.retire-outer-host",
        ]),
      ],
      ["controller_stage", selected(own(diagnostic, "stage"), stages)],
      [
        "controller_kind",
        selected(own(diagnostic, "kind"), [
          "operation-grace-unsettled",
          "pull-outcome-unknown",
          "preparation-failed",
        ]),
      ],
      [
        "controller_cleanup",
        selected(own(diagnostic, "cleanup"), [
          "none",
          "failed",
          "not-attempted",
        ]),
      ],
      [
        "controller_pull_trigger",
        selected(own(image, "trigger"), [
          "abort",
          "timeout",
          "transport",
          "unexpected-status",
          "empty-events",
          "malformed-event",
          "daemon-error-event",
        ]),
      ],
      [
        "controller_reconciliation",
        selected(own(image, "reconciliation"), [
          "completed",
          "failed",
          "not-attempted",
        ]),
      ],
    ],
    environment,
  );
};
