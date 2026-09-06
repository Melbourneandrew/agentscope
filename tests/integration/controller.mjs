import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runSupervisedProcess } from "./supervisor.mjs";

const defaultMaximumControllerMilliseconds = 24 * 60 * 1000;
const suppliedOuterDeadline =
  process.env.AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS;
const hostMonotonicMilliseconds = () =>
  Number(readFileSync("/proc/uptime", "utf8").split(" ", 1)[0]) * 1000;
let maximumControllerMilliseconds = defaultMaximumControllerMilliseconds;
if (suppliedOuterDeadline !== undefined) {
  if (!/^\d{7,15}$/u.test(suppliedOuterDeadline))
    throw new Error("integration.controller.outer-deadline");
  maximumControllerMilliseconds = Math.min(
    maximumControllerMilliseconds,
    Number(suppliedOuterDeadline) - hostMonotonicMilliseconds(),
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
if (result.code !== 0 || !result.contained || result.residualWorkObserved) {
  process.stderr.write(
    `${result.contained && !result.residualWorkObserved ? "integration.controller.failed" : "integration.controller.containment"}\n`,
  );
  process.exitCode = result.code === 0 ? 1 : (result.code ?? 1);
}
