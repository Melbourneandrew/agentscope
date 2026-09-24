import { executeIntegrationController } from "./dist/controller.js";

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
  process.stderr.write(`${messages.join("\n")}\n`);
  process.exit(1);
}
