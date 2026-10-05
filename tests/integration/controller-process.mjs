import { executeIntegrationController } from "./dist/controller.js";
import { formatControllerFailureDiagnostic } from "./dist/controller-failure-diagnostic.js";

try {
  const disposition = await executeIntegrationController();
  if (disposition === "mockserver-research-complete") process.exitCode = 3;
} catch (error) {
  process.stderr.write(formatControllerFailureDiagnostic(error));
  process.exit(1);
}
