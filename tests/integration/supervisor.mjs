import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const containmentProofMilliseconds = 5_000;
const containmentPollMilliseconds = 10;

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const signalGroup = (processGroup, signal) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, signal);
    else process.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const groupIsAbsent = (processGroup) => {
  try {
    if (process.platform === "win32") process.kill(processGroup, 0);
    else process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
};

const proveGroupAbsent = async (processGroup) => {
  const deadline = performance.now() + containmentProofMilliseconds;
  while (performance.now() < deadline) {
    if (groupIsAbsent(processGroup)) return true;
    await delay(containmentPollMilliseconds);
  }
  return groupIsAbsent(processGroup);
};

export const runSupervisedProcess = async ({
  arguments_: arguments_ = [],
  environment,
  executable,
  maximumMilliseconds,
  stdio = "inherit",
}) => {
  const child = spawn(executable, arguments_, {
    detached: process.platform !== "win32",
    env: environment,
    stdio,
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1)
    throw new Error("integration.controller.spawn");
  const processGroup = child.pid;
  let forcedTimer;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup(processGroup, "SIGTERM");
    forcedTimer = setTimeout(() => {
      signalGroup(processGroup, "SIGKILL");
    }, containmentProofMilliseconds);
  };
  const deadlineTimer = setTimeout(terminate, maximumMilliseconds);
  const forwardSignal = () => {
    terminate();
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      child.once("close", (code, signal) => {
        resolveResult({ code, signal });
      });
    });
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    const residualWorkObserved = signalGroup(processGroup, "SIGKILL");
    const contained = await proveGroupAbsent(processGroup);
    return { ...result, contained, residualWorkObserved };
  } finally {
    clearTimeout(deadlineTimer);
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
};
