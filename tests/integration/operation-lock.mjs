import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const lockName = ".agentscope-integration-operation-lock";
const ownerName = "owner.json";

const processIsAlive = (pid, errorCode) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error(errorCode, { cause: error });
  }
};

const readOwner = (lockPath) => {
  try {
    const status = lstatSync(lockPath);
    const ownerPath = resolve(lockPath, ownerName);
    const ownerStatus = lstatSync(ownerPath);
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      !ownerStatus.isFile() ||
      ownerStatus.isSymbolicLink() ||
      JSON.stringify(Object.keys(owner).sort()) !==
        JSON.stringify(["lockVersion", "pid"]) ||
      owner.lockVersion !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1
    )
      return undefined;
    return owner;
  } catch {
    return undefined;
  }
};

export const acquireIntegrationOperationLock = (workspaceRoot, errorCode) => {
  const artifacts = resolve(workspaceRoot, "artifacts");
  const lockPath = resolve(artifacts, lockName);
  mkdirSync(artifacts, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST")
        throw new Error(errorCode, { cause: error });
      const owner = readOwner(lockPath);
      if (owner === undefined || processIsAlive(owner.pid, errorCode))
        throw new Error(errorCode, { cause: error });
      const stalePath = `${lockPath}.stale-${process.pid}-${attempt}`;
      try {
        renameSync(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw new Error(errorCode, { cause: renameError });
      }
      rmSync(stalePath, { recursive: true });
      continue;
    }
    try {
      writeFileSync(
        resolve(lockPath, ownerName),
        `${JSON.stringify({ lockVersion: 1, pid: process.pid })}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      rmSync(lockPath, { force: true, recursive: true });
      throw new Error(errorCode, { cause: error });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const owner = readOwner(lockPath);
      if (owner?.pid === process.pid)
        rmSync(lockPath, { force: true, recursive: true });
    };
  }
  throw new Error(errorCode);
};
