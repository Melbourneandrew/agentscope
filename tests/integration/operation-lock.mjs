import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";

const minimumPort = 20_000;
const portCount = 20_000;

const operationLockPort = (workspaceRoot) => {
  const digest = createHash("sha256")
    .update(realpathSync(workspaceRoot))
    .digest();
  return minimumPort + (digest.readUInt16BE(0) % portCount);
};

export const acquireIntegrationOperationLock = async (
  workspaceRoot,
  errorCode,
) => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const fail = (error) => reject(new Error(errorCode, { cause: error }));
    server.once("error", fail);
    server.listen(
      {
        host: "127.0.0.1",
        port: operationLockPort(workspaceRoot),
        exclusive: true,
      },
      () => {
        server.off("error", fail);
        resolve();
      },
    );
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(new Error(errorCode, { cause: error }));
      });
    });
  };
};
