import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { performance } from "node:perf_hooks";

const minimumPort = 20_000;
const portCount = 20_000;
const maximumOperationLockWaitMilliseconds = 60_000;
const retryDelayMilliseconds = 10;

const operationLockPort = (workspaceRoot) => {
  const digest = createHash("sha256")
    .update(realpathSync(workspaceRoot))
    .digest();
  return minimumPort + (digest.readUInt16BE(0) % portCount);
};

const timeoutCause = () => {
  const error = new Error("integration.operation-lock.timeout");
  error.code = "ETIMEDOUT";
  return error;
};

const operationTimeoutError = (errorCode, cause) => {
  const error = new Error(errorCode, { cause });
  error.code = "ETIMEDOUT";
  return error;
};

const waitForOwnerRelease = (port, remainingMilliseconds) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      operation(value);
    };
    const timer = setTimeout(
      () => finish(reject, timeoutCause()),
      remainingMilliseconds,
    );
    socket.once("close", () => finish(resolve));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ECONNRESET") {
        finish(resolve);
        return;
      }
      finish(reject, error);
    });
  });

const delayBeforeRetry = (remainingMilliseconds) =>
  new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.min(retryDelayMilliseconds, remainingMilliseconds),
    ),
  );

export const acquireIntegrationOperationLock = async (
  workspaceRoot,
  errorCode,
  options = {},
) => {
  const maximumWaitMilliseconds =
    options.maximumWaitMilliseconds ?? maximumOperationLockWaitMilliseconds;
  if (
    !Number.isSafeInteger(maximumWaitMilliseconds) ||
    maximumWaitMilliseconds < 1 ||
    maximumWaitMilliseconds > maximumOperationLockWaitMilliseconds
  )
    throw operationTimeoutError(errorCode, timeoutCause());
  const port = operationLockPort(workspaceRoot);
  const deadline = performance.now() + maximumWaitMilliseconds;
  let server;
  let waitingSockets;
  let released = false;
  for (;;) {
    waitingSockets = new Set();
    server = createServer((socket) => {
      if (released) {
        socket.destroy();
        return;
      }
      waitingSockets.add(socket);
      socket.once("close", () => waitingSockets.delete(socket));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          server.removeAllListeners("error");
          resolve();
        });
      });
      break;
    } catch (error) {
      if (error?.code !== "EADDRINUSE")
        throw new Error(errorCode, { cause: error });
      const remainingMilliseconds = deadline - performance.now();
      if (remainingMilliseconds <= 0)
        throw operationTimeoutError(errorCode, error);
      try {
        await waitForOwnerRelease(port, remainingMilliseconds);
      } catch (waitError) {
        if (waitError?.code === "ETIMEDOUT")
          throw operationTimeoutError(errorCode, waitError);
        throw new Error(errorCode, { cause: waitError });
      }
      const retryRemainingMilliseconds = deadline - performance.now();
      if (retryRemainingMilliseconds <= 0)
        throw operationTimeoutError(errorCode, error);
      await delayBeforeRetry(retryRemainingMilliseconds);
      if (deadline - performance.now() <= 0)
        throw operationTimeoutError(errorCode, error);
    }
  }
  return async () => {
    if (released) return;
    released = true;
    const closed = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(new Error(errorCode, { cause: error }));
      });
    });
    for (const socket of waitingSockets) socket.destroy();
    await closed;
  };
};
