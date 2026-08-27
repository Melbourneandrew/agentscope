import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_PREFIX = "agentscope-";
const WORKSTREAM_PATTERN = /^[a-z][a-z0-9]{1,19}$/;
const RESERVED_ARGUMENTS = new Set([
  "--actor", "--db", "--directory", "-C", "--dolt-auto-commit", "--dry-run", "--file", "-f",
  "--force", "--global", "--graph", "--id", "--ignore-schema-skew", "--json", "--profile",
  "--quiet", "-q", "--readonly", "--repo", "--sandbox", "--silent", "--title", "--verbose", "-v",
]);
const LIST_ARGUMENTS = ["list", "--all", "--flat", "--limit", "0", "--json", "--readonly"];
const LOCK_RETRY_LIMIT = 200;
const LOCK_NAME = "create-allocation.lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RELEASED_FILE = "released";

export function canonicalIssueId(reference) {
  if (typeof reference !== "string") return "";
  const trimmed = reference.trim();
  if (/^agentscope-[a-z][a-z0-9]{1,19}-\d{3}$/.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9]{1,19}-\d{3}$/.test(trimmed)) return `${PROJECT_PREFIX}${trimmed}`;
  return trimmed;
}

export function humanIssueId(id) {
  return typeof id === "string" && id.startsWith(PROJECT_PREFIX) ? id.slice(PROJECT_PREFIX.length) : id;
}

export function nextIssueNumber(issues, workstream) {
  if (!WORKSTREAM_PATTERN.test(workstream)) {
    throw new Error("Workstream must be 2-20 lowercase letters or digits and start with a letter");
  }
  if (!Array.isArray(issues)) throw new Error("bd list returned a non-array JSON document");
  const pattern = new RegExp(`^${PROJECT_PREFIX}${workstream}-(\\d{3})$`);
  let highest = 0;
  for (const issue of issues) {
    const match = typeof issue?.id === "string" ? pattern.exec(issue.id) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  if (highest >= 999) throw new Error(`Workstream ${workstream} has exhausted its three-digit ID space`);
  return highest + 1;
}

function normalizeDependencies(value) {
  return value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator === -1) return canonicalIssueId(entry);
    return `${entry.slice(0, separator)}:${canonicalIssueId(entry.slice(separator + 1))}`;
  }).join(",");
}

function isReservedArgument(argument) {
  return [...RESERVED_ARGUMENTS].some((flag) => argument === flag || argument.startsWith(`${flag}=`) ||
    (flag.startsWith("-") && !flag.startsWith("--") && argument.startsWith(flag)));
}

function normalizeReferenceArguments(arguments_) {
  const normalized = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (isReservedArgument(argument)) throw new Error(`The creation helper owns ${argument.split("=")[0]}`);
    if (argument === "--parent" || argument === "--waits-for" || argument === "--event-target") {
      const parent = arguments_[index + 1];
      if (!parent) throw new Error(`${argument} requires an issue reference`);
      normalized.push(argument, canonicalIssueId(parent));
      index += 1;
    } else if (["--parent=", "--waits-for=", "--event-target="].some((prefix) => argument.startsWith(prefix))) {
      const separator = argument.indexOf("=");
      normalized.push(`${argument.slice(0, separator + 1)}${canonicalIssueId(argument.slice(separator + 1))}`);
    } else if (argument === "--deps") {
      const dependencies = arguments_[index + 1];
      if (!dependencies) throw new Error("--deps requires dependency references");
      normalized.push(argument, normalizeDependencies(dependencies));
      index += 1;
    } else if (argument.startsWith("--deps=")) {
      normalized.push(`--deps=${normalizeDependencies(argument.slice("--deps=".length))}`);
    } else {
      normalized.push(argument);
    }
  }
  return normalized;
}

async function readIssues(run) {
  const { stdout } = await run("bd", LIST_ARGUMENTS, {
    cwd: REPOSITORY_DIRECTORY, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000,
  });
  try { return JSON.parse(stdout); } catch { throw new Error("bd list returned malformed JSON"); }
}

async function issueExists(run, candidate) {
  try {
    const { stdout } = await run("bd", ["show", candidate, "--json", "--readonly"], {
      cwd: REPOSITORY_DIRECTORY, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000,
    });
    let decoded;
    try { decoded = JSON.parse(stdout); } catch { throw new Error("bd show returned malformed JSON"); }
    if (!Array.isArray(decoded) || decoded.length !== 1 || decoded[0]?.id !== candidate) {
      throw new Error("bd show returned an unexpected issue document");
    }
    return true;
  } catch (error) {
    let decoded;
    try { decoded = JSON.parse(error?.stdout ?? ""); } catch {
      throw new Error("Unable to prove that the candidate Beads ID is unused");
    }
    const keys = decoded && typeof decoded === "object" ? Object.keys(decoded).sort() : [];
    if (error?.code === 1 && keys.length === 2 && keys[0] === "error" && keys[1] === "schema_version" &&
      decoded.schema_version === 1 && decoded.error === "no issues found matching the provided IDs") return false;
    throw new Error("Unable to prove that the candidate Beads ID is unused");
  }
}

async function beadsDirectory(run) {
  const { stdout } = await run("bd", ["where", "--json", "--readonly"], {
    cwd: REPOSITORY_DIRECTORY, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000,
  });
  let decoded;
  try { decoded = JSON.parse(stdout); } catch { throw new Error("bd where returned malformed JSON"); }
  if (typeof decoded?.path !== "string" || !path.isAbsolute(decoded.path)) {
    throw new Error("bd where returned an invalid workspace path");
  }
  return decoded.path;
}

async function readProcessStart(pid) {
  const { stdout } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", maxBuffer: 4096, timeout: 5_000,
  });
  const identity = stdout.trim();
  if (!identity || identity.length > 128) throw new Error("invalid process identity");
  return identity;
}

export async function observeProcessIdentity(pid, { signal = process.kill, readStart = readProcessStart } = {}) {
  try { signal(pid, 0); } catch (error) {
    return error?.code === "ESRCH" ? { state: "absent" } : { state: "unknown" };
  }
  try { return { state: "present", identity: await readStart(pid) }; } catch { return { state: "unknown" }; }
}

async function removeOwnedDirectory(directory) {
  let entries;
  try { entries = (await readdir(directory)).sort(); } catch { return false; }
  if (entries.some((entry) => entry !== LOCK_OWNER_FILE && entry !== LOCK_RELEASED_FILE)) return false;
  try { await unlink(path.join(directory, LOCK_RELEASED_FILE)); } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    await unlink(path.join(directory, LOCK_OWNER_FILE));
    await rmdir(directory);
    return true;
  } catch { return false; }
}

async function readLockOwner(lockPath) {
  try {
    const raw = await readFile(path.join(lockPath, LOCK_OWNER_FILE), { encoding: "utf8", flag: "r" });
    if (raw.length > 1024) return null;
    const owner = JSON.parse(raw);
    if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.processStart !== "string" || !/^[0-9a-f-]{36}$/.test(owner.token)) return null;
    return owner;
  } catch { return null; }
}

async function retireLock(lockPath, directory, suffix) {
  const retired = path.join(directory, `.create-allocation.${randomUUID()}.${suffix}`);
  try { await rename(lockPath, retired); } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
  if (!(await removeOwnedDirectory(retired))) {
    process.stderr.write("A retired Beads allocation lock retained its authenticated cleanup evidence.\n");
  }
  return true;
}

async function recoverStaleLock(lockPath, directory) {
  const owner = await readLockOwner(lockPath);
  if (!owner) return false;
  try {
    const released = await readFile(path.join(lockPath, LOCK_RELEASED_FILE), { encoding: "utf8", flag: "r" });
    if (released.trim() !== owner.token) return false;
    return retireLock(lockPath, directory, "released");
  } catch (error) { if (error?.code !== "ENOENT") return false; }
  const observation = await observeProcessIdentity(owner.pid);
  if (observation.state === "absent" || (observation.state === "present" && observation.identity !== owner.processStart)) {
    return retireLock(lockPath, directory, "stale");
  }
  return false;
}

async function reconcileAllocatorArtifacts(directory) {
  let entries;
  try { entries = await readdir(directory); } catch { return; }
  for (const entry of entries
    .filter((name) => /^\.create-allocation\.[0-9a-f-]{36}\.(pending|released|stale)$/.test(name))
    .slice(0, 256)) {
    const artifactPath = path.join(directory, entry);
    const owner = await readLockOwner(artifactPath);
    if (!owner) continue;
    if (entry.endsWith(".released") || entry.endsWith(".stale")) {
      await removeOwnedDirectory(artifactPath);
      continue;
    }
    const observation = await observeProcessIdentity(owner.pid);
    if (observation.state === "absent" || (observation.state === "present" && observation.identity !== owner.processStart)) {
      await removeOwnedDirectory(artifactPath);
    }
  }
}

export async function acquireAllocationLock(run, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const directory = await beadsDirectory(run);
  await reconcileAllocatorArtifacts(directory);
  const lockPath = path.join(directory, LOCK_NAME);
  const self = await observeProcessIdentity(process.pid);
  if (self.state !== "present") throw new Error("Unable to establish Beads allocator process identity");
  const token = randomUUID();
  const stagingPath = path.join(directory, `.create-allocation.${token}.pending`);
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    await writeFile(path.join(stagingPath, LOCK_OWNER_FILE),
      `${JSON.stringify({ version: 1, token, pid: process.pid, processStart: self.identity })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await removeOwnedDirectory(stagingPath);
    throw error;
  }
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      await rename(stagingPath, lockPath);
      return async () => {
        try {
          const owner = await readLockOwner(lockPath);
          if (owner?.token !== token) throw new Error("ownership changed");
          await writeFile(path.join(lockPath, LOCK_RELEASED_FILE), `${token}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 });
          await retireLock(lockPath, directory, "released");
        } catch {
          process.stderr.write("Beads ID allocation completed; the next helper run will reconcile its released lock.\n");
        }
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        await removeOwnedDirectory(stagingPath);
        throw error;
      }
      await recoverStaleLock(lockPath, directory);
      await wait(50);
    }
  }
  await removeOwnedDirectory(stagingPath);
  throw new Error("Another Beads ID allocation is still active; retry after it finishes");
}

export async function createSequentialIssue({ workstream, title, arguments_ = [], run = executeFile, lock = acquireAllocationLock }) {
  if (typeof title !== "string" || !title.trim()) throw new Error("Title must not be empty");
  const passthrough = normalizeReferenceArguments(arguments_);
  const releaseLock = await lock(run);
  try {
    let sequence = nextIssueNumber(await readIssues(run), workstream);
    for (let attempts = 0; attempts < 100 && sequence <= 999; attempts += 1, sequence += 1) {
      const candidate = `${PROJECT_PREFIX}${workstream}-${String(sequence).padStart(3, "0")}`;
      if (await issueExists(run, candidate)) continue;
      await run("bd", ["create", "--title", title.trim(), "--id", candidate, "--silent", ...passthrough], {
        cwd: REPOSITORY_DIRECTORY, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000,
      });
      return humanIssueId(candidate);
    }
    throw new Error(`Unable to allocate an ID in the ${workstream} workstream`);
  } finally { await releaseLock(); }
}

export function parseArguments(arguments_) {
  if (arguments_.length < 2) throw new Error('Usage: node .beads/create.mjs <workstream> "<title>" [bd create options]');
  return { workstream: arguments_[0], title: arguments_[1], arguments_: arguments_.slice(2) };
}

async function main() {
  const created = await createSequentialIssue(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${created}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
