import { spawn } from "node:child_process";
import { resolve } from "node:path";

const maximumControllerMilliseconds = 24 * 60 * 1000;
const forcedTerminationMilliseconds = 5_000;
const child = spawn(
  process.execPath,
  [resolve(import.meta.dirname, "controller-process.mjs")],
  {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "inherit",
  },
);
let forcedTimer;
const terminate = () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") child.kill("SIGTERM");
  else process.kill(-child.pid, "SIGTERM");
  forcedTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  }, forcedTerminationMilliseconds);
};
const deadlineTimer = setTimeout(terminate, maximumControllerMilliseconds);
const forwardSignal = () => {
  terminate();
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);
const result = await new Promise((resolveResult, rejectResult) => {
  child.once("error", rejectResult);
  child.once("close", (code, signal) => {
    resolveResult({ code, signal });
  });
});
clearTimeout(deadlineTimer);
if (forcedTimer !== undefined) clearTimeout(forcedTimer);
process.removeListener("SIGINT", forwardSignal);
process.removeListener("SIGTERM", forwardSignal);
if (result.code !== 0) {
  process.stderr.write(
    `${result.signal === null ? "integration.controller.failed" : "integration.controller.terminated"}\n`,
  );
  process.exitCode = result.code ?? 1;
}
