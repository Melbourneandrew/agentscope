import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { executeIntegrationController } from "./dist/controller.js";
import { drainFailureDiagnostic } from "./failure-diagnostic-drain.mjs";

const outerDeadline =
  process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
const bootNow = () =>
  Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000;
const localDeadline = performance.now() + 23 * 60 * 1000;
const useOuterDeadline =
  process.platform === "linux" &&
  typeof outerDeadline === "string" &&
  /^\d{7,15}$/u.test(outerDeadline);

try {
  await executeIntegrationController();
} catch (error) {
  const messages = [
    error?.message ?? "integration.controller.failed",
    error?.primaryCause?.message,
    error?.cleanupCause?.message,
  ].filter(
    (message, index, values) => message && values.indexOf(message) === index,
  );
  await drainFailureDiagnostic({
    deadlineMilliseconds: useOuterDeadline
      ? Number(outerDeadline)
      : localDeadline,
    now: useOuterDeadline ? bootNow : () => performance.now(),
    output: `${messages.join("\n")}\n`,
    stream: process.stderr,
  });
  process.exit(1);
}
