import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSkillPath } from "./skill-usage.js";

const SKILL_MD_PATH_RE = /\/skills\/[A-Za-z0-9._-]+\/SKILL\.md$/;
const STALE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Directory where pending skill reads are spooled, one file per read event. */
export function spoolDir(): string {
  return join(tmpdir(), "sf-langfuse-cursor-skill-reads");
}

export type RecordSkillReadInput = {
  filePath: string;
  conversationId: string;
  generationId: string;
};

type SpoolEntry = { skill: string };

/** Monotonically increasing per-process counter, to disambiguate same-millisecond writes. */
let eventCounter = 0;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function convHash(conversationId: string): string {
  return shortHash(conversationId);
}

function genHash(generationId: string): string {
  return shortHash(generationId);
}

/** Prefix identifying every spool file for a conversation, any generation. */
function conversationPrefix(conversationId: string): string {
  return `${convHash(conversationId)}--`;
}

/** Prefix identifying every spool file for a conversation + generation pair. */
function generationPrefix(
  conversationId: string,
  generationId: string,
): string {
  return `${convHash(conversationId)}--${genHash(generationId)}--`;
}

function eventFile(dir: string, prefix: string, counter: number): string {
  return join(dir, `${prefix}${Date.now()}-${process.pid}-${counter}.json`);
}

/**
 * Records a skill-file read to the local spool for later pickup by the turn
 * reporter, as a new, uniquely-named file per read event. Non-skill paths
 * are a no-op. Never throws.
 */
export function recordSkillRead(
  { filePath, conversationId, generationId }: RecordSkillReadInput,
  dir: string = spoolDir(),
): void {
  try {
    if (!conversationId || !generationId) {
      return;
    }
    if (!SKILL_MD_PATH_RE.test(filePath)) {
      return;
    }
    const skill = normalizeSkillPath(filePath);
    mkdirSync(dir, { recursive: true });
    const prefix = generationPrefix(conversationId, generationId);
    const entry: SpoolEntry = { skill };
    const content = JSON.stringify(entry);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const counter = eventCounter;
      eventCounter += 1;
      try {
        writeFileSync(eventFile(dir, prefix, counter), content, { flag: "wx" });
        return;
      } catch {
        // Name collision (same ms, same pid, same counter across processes is
        // effectively impossible, but be defensive): bump and retry once.
      }
    }
  } catch {
    // Never block or fail the file read on spooling errors.
  }
}

/**
 * Best-effort removal of stale spool files left behind by reads that never
 * got acked, scoped to OWN conversation only: sweeps files under
 * `conversationPrefix` (this conversation, any generation) that are older
 * than 24h, skipping anything under `currentGenerationPrefix` — those were
 * just returned by this peek for reporting and must only be removed by a
 * later `ackSkillReads` call, never swept out from under an in-flight
 * report.
 *
 * Deliberately does NOT touch other conversations' files, even if they're
 * stale: a process only ever knows its own conversation id, so it has no
 * way to distinguish "abandoned" from "mid-retry" for a conversation it
 * isn't currently handling. Files from truly abandoned conversations are
 * reclaimed by the OS's tmpdir reaper instead.
 */
function cleanupStaleFiles(
  dir: string,
  conversationPrefixValue: string,
  currentGenerationPrefix: string,
): void {
  const now = Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (
      !name.endsWith(".json") ||
      !name.startsWith(conversationPrefixValue) ||
      name.startsWith(currentGenerationPrefix)
    ) {
      continue;
    }
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (now - stats.mtimeMs > STALE_FILE_MAX_AGE_MS) {
        unlinkSync(path);
      }
    } catch {
      // Best effort; skip files we can't stat or unlink.
    }
  }
}

export type PeekSkillReadsResult = {
  skills: string[];
  files: string[];
};

/**
 * Reads all spooled read-event files for a given conversation + generation
 * WITHOUT removing them, returning the unique skill names read and the
 * exact file paths read. Files are only removed by a later `ackSkillReads`
 * call with those same paths, so a read event that lands between a peek
 * and its ack is never lost — it simply isn't in `files` yet, and survives
 * for the next peek. Also opportunistically sweeps this conversation's own
 * spool files older than 24h left behind by reads that were never acked
 * (see cleanupStaleFiles for why other conversations' files are left
 * alone). Never throws.
 */
export function peekSkillReads(
  conversationId: string,
  generationId: string,
  dir: string = spoolDir(),
): PeekSkillReadsResult {
  try {
    const prefix = generationPrefix(conversationId, generationId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }

    const files: string[] = [];
    const seen = new Set<string>();
    const skills: string[] = [];

    for (const name of names) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const path = join(dir, name);
      let entry: SpoolEntry | undefined;
      try {
        entry = JSON.parse(readFileSync(path, "utf8")) as SpoolEntry;
      } catch {
        continue;
      }
      files.push(path);
      if (!seen.has(entry.skill)) {
        seen.add(entry.skill);
        skills.push(entry.skill);
      }
    }

    cleanupStaleFiles(dir, conversationPrefix(conversationId), prefix);

    return { skills, files };
  } catch {
    return { skills: [], files: [] };
  }
}

/**
 * Acknowledges (removes) exactly the given spool files, as previously
 * returned by `peekSkillReads`. Call only after those peeked skill reads
 * have been successfully reported, so a failed report leaves the spool
 * intact for a future retry. Never throws.
 */
export function ackSkillReads(files: string[]): void {
  for (const file of files) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    } catch {
      // Never throw on ack failures; a stray file is swept later by cleanupStaleFiles.
    }
  }
}
