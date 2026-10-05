import { executeIntegrationController } from "./dist/controller.js";
import { formatControllerFailureDiagnostic } from "./dist/controller-failure-diagnostic.js";

try {
  await executeIntegrationController();
} catch (error) {
  process.stderr.write(formatControllerFailureDiagnostic(error));
  process.exit(1);
}
