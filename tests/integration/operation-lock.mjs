import { randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const lockName = ".agentscope-integration-operation-lock";
const candidatePattern =
  /^\.agentscope-integration-operation-lock\.candidate-(\d+)-[a-f0-9]{16}$/u;

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
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
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

const removeStaleCandidates = (artifacts, errorCode) => {
  const entries = readdirSync(artifacts, { withFileTypes: true });
  if (entries.length > 1024) throw new Error(errorCode);
  for (const entry of entries) {
    if (!entry.name.startsWith(`${lockName}.candidate-`)) continue;
    const match = candidatePattern.exec(entry.name);
    const path = resolve(artifacts, entry.name);
    if (
      match === null ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !Number.isSafeInteger(Number(match[1])) ||
      Number(match[1]) < 1
    )
      throw new Error(errorCode);
    if (processIsAlive(Number(match[1]), errorCode)) throw new Error(errorCode);
    rmSync(path);
  }
};

const publishOwner = (artifacts, lockPath) => {
  const candidate = resolve(
    artifacts,
    `${lockName}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  writeFileSync(
    candidate,
    `${JSON.stringify({ lockVersion: 1, pid: process.pid })}\n`,
    { flag: "wx" },
  );
  try {
    linkSync(candidate, lockPath);
  } finally {
    rmSync(candidate, { force: true });
  }
};

export const acquireIntegrationOperationLock = (workspaceRoot, errorCode) => {
  const artifacts = resolve(workspaceRoot, "artifacts");
  const lockPath = resolve(artifacts, lockName);
  mkdirSync(artifacts, { recursive: true });
  removeStaleCandidates(artifacts, errorCode);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      publishOwner(artifacts, lockPath);
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
      rmSync(stalePath);
      continue;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const owner = readOwner(lockPath);
      if (owner?.pid === process.pid) rmSync(lockPath, { force: true });
    };
  }
  throw new Error(errorCode);
};
