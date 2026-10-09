import { writeSync } from "node:fs";
import { executeIntegrationController } from "./dist/controller.js";
import {
  formatControllerFailureDiagnostic,
  readControllerFailureDiagnostic,
} from "./dist/controller-failure-diagnostic.js";
import { publishControllerFailureObservation } from "./controller-file-command.mjs";

try {
  const disposition = await executeIntegrationController();
  if (disposition === "mockserver-research-complete") process.exitCode = 3;
} catch (error) {
  publishControllerFailureObservation(readControllerFailureDiagnostic(error));
  try {
    const bytes = Buffer.from(formatControllerFailureDiagnostic(error));
    if (bytes.length <= 4096) writeSync(2, bytes);
  } catch {
    /* Optional diagnostics never replace failure status. */
  }
  process.exit(1);
}
