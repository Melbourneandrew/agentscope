import { execFile } from "node:child_process";
import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_PREFIX = "agentscope-";
const WORKSTREAM_PATTERN = /^[a-z][a-z0-9]{1,19}$/;
const RESERVED_ARGUMENTS = new Set([
  "--dry-run",
  "--file",
  "-f",
  "--force",
  "--graph",
  "--id",
  "--json",
  "--readonly",
  "--silent",
  "--title",
]);
const LIST_ARGUMENTS = ["list", "--all", "--flat", "--limit", "0", "--json", "--readonly"];
const LOCK_RETRY_LIMIT = 200;

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
  return value
    .split(",")
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) return canonicalIssueId(entry);
      return `${entry.slice(0, separator)}:${canonicalIssueId(entry.slice(separator + 1))}`;
    })
    .join(",");
}

function normalizeReferenceArguments(arguments_) {
  const normalized = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (RESERVED_ARGUMENTS.has(argument) || [...RESERVED_ARGUMENTS].some((flag) => argument.startsWith(`${flag}=`))) {
      throw new Error(`The creation helper owns ${argument.split("=")[0]}`);
    }
    if (argument === "--parent") {
      const parent = arguments_[index + 1];
      if (!parent) throw new Error("--parent requires an issue reference");
      normalized.push(argument, canonicalIssueId(parent));
      index += 1;
      continue;
    }
    if (argument.startsWith("--parent=")) {
      normalized.push(`--parent=${canonicalIssueId(argument.slice("--parent=".length))}`);
      continue;
    }
    if (argument === "--deps") {
      const dependencies = arguments_[index + 1];
      if (!dependencies) throw new Error("--deps requires dependency references");
      normalized.push(argument, normalizeDependencies(dependencies));
      index += 1;
      continue;
    }
    if (argument.startsWith("--deps=")) {
      normalized.push(`--deps=${normalizeDependencies(argument.slice("--deps=".length))}`);
      continue;
    }
    normalized.push(argument);
  }
  return normalized;
}

async function readIssues(run) {
  const { stdout } = await run("bd", LIST_ARGUMENTS, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("bd list returned malformed JSON");
  }
}

async function issueExists(run, candidate) {
  try {
    const { stdout } = await run("bd", ["show", candidate, "--json", "--readonly"], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const decoded = JSON.parse(stdout);
    return Array.isArray(decoded) && decoded.some((issue) => issue?.id === candidate);
  } catch {
    return false;
  }
}

async function beadsDirectory(run) {
  const { stdout } = await run("bd", ["where", "--json", "--readonly"], {
    cwd: REPOSITORY_DIRECTORY,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  let decoded;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error("bd where returned malformed JSON");
  }
  if (typeof decoded?.path !== "string" || !path.isAbsolute(decoded.path)) {
    throw new Error("bd where returned an invalid workspace path");
  }
  return decoded.path;
}

async function acquireAllocationLock(run, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
  const lockPath = path.join(await beadsDirectory(run), "create-allocation.lock");
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try {
          await rmdir(lockPath);
        } catch {
          process.stderr.write("Beads ID allocation completed, but its empty local lock needs operator cleanup.\n");
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await wait(50);
    }
  }
  throw new Error("Another Beads ID allocation is still active; retry after it finishes");
}

export async function createSequentialIssue({
  workstream,
  title,
  arguments_ = [],
  run = executeFile,
  lock = acquireAllocationLock,
}) {
  if (typeof title !== "string" || !title.trim()) throw new Error("Title must not be empty");
  const passthrough = normalizeReferenceArguments(arguments_);
  const releaseLock = await lock(run);
  try {
    let sequence = nextIssueNumber(await readIssues(run), workstream);
    for (let attempts = 0; attempts < 100 && sequence <= 999; attempts += 1, sequence += 1) {
      const candidate = `${PROJECT_PREFIX}${workstream}-${String(sequence).padStart(3, "0")}`;
      if (await issueExists(run, candidate)) continue;
      await run("bd", ["create", title.trim(), "--id", candidate, "--silent", ...passthrough], {
        cwd: REPOSITORY_DIRECTORY,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
      });
      return humanIssueId(candidate);
    }
    throw new Error(`Unable to allocate an ID in the ${workstream} workstream`);
  } finally {
    await releaseLock();
  }
}

export function parseArguments(arguments_) {
  if (arguments_.length < 2) {
    throw new Error('Usage: node .beads/create.mjs <workstream> "<title>" [bd create options]');
  }
  return { workstream: arguments_[0], title: arguments_[1], arguments_: arguments_.slice(2) };
}

async function main() {
  const created = await createSequentialIssue(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${created}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
