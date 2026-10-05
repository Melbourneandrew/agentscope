import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runSupervisedProcess } from "./supervisor.mjs";
import { mockServerResearchStopFitsTerminalObservation } from "./dist/mockserver-research-request.js";

const defaultMaximumControllerMilliseconds = 24 * 60 * 1000;
const suppliedOuterDeadline =
  process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
const hostMonotonicMilliseconds = () =>
  Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000;
let maximumControllerMilliseconds = defaultMaximumControllerMilliseconds;
if (suppliedOuterDeadline !== undefined) {
  if (!/^\d{7,15}$/u.test(suppliedOuterDeadline))
    throw new Error("integration.controller.outer-deadline");
  maximumControllerMilliseconds = Math.floor(
    Math.min(
      maximumControllerMilliseconds,
      Number(suppliedOuterDeadline) - hostMonotonicMilliseconds(),
    ),
  );
}
if (maximumControllerMilliseconds < 2 * 60 * 1000)
  throw new Error("integration.controller.outer-deadline");

const result = await runSupervisedProcess({
  environment: process.env,
  executable: process.execPath,
  arguments_: [resolve(import.meta.dirname, "controller-process.mjs")],
  maximumMilliseconds: maximumControllerMilliseconds,
});
if (mockServerResearchStopFitsTerminalObservation(result)) {
  process.exitCode = 3;
} else if (
  result.code !== 0 ||
  !result.contained ||
  result.residualWorkObserved
) {
  process.stderr.write(
    `${result.contained && !result.residualWorkObserved ? "integration.controller.failed" : "integration.controller.containment"}\n`,
  );
  process.exitCode =
    result.code === 0 || result.code === 3 ? 1 : (result.code ?? 1);
}
// Optional content-free diagnostics cannot replace the settled outcome.
try {
  process.stdout.once("error", () => undefined);
  process.stdout.write(
    `${JSON.stringify({
      kind: "integration.controller.supervised-terminal",
      code:
        Number.isInteger(result.code) && result.code >= 0 && result.code <= 255
          ? result.code
          : null,
      signal: [
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
      ].includes(result.signal)
        ? result.signal
        : result.signal === null
          ? null
          : "unknown",
      contained: result.contained === true,
      residualWorkObserved: result.residualWorkObserved === true,
      terminationInitiated: result.terminationInitiated === true,
      completedWithinDeadline: result.completedWithinDeadline === true,
    })}\n`,
    () => undefined,
  );
} catch {
  // Missing diagnostics remain unknown, never successful-retirement evidence.
}
