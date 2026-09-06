import { executeIntegrationController } from "./dist/controller.js";

try {
  await executeIntegrationController();
} catch (error) {
  process.stderr.write(
    `${error?.message ?? "integration.controller.failed"}\n`,
  );
  process.exitCode = 1;
}
