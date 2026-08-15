import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeClaudeProjectPath,
  encodeCursorProjectPath,
} from "../native-traces/index.js";

export type NativeTurnFixtureProvider = "cursor" | "codex" | "claude-code";

export type NativeTurnFixtureWorkspace = {
  cwd: string;
  sourcePath: string;
  cleanup(): void;
  adapterOptions: Record<string, unknown>;
  rawHookPayload: Record<string, unknown>;
};

export function createNativeTurnFixtureWorkspace(
  provider: NativeTurnFixtureProvider,
  options: {
    cwd?: string;
    sessionId?: string;
    turnId?: string;
    branch?: string;
  } = {},
): NativeTurnFixtureWorkspace {
  const tempDir = mkdtempSync(join(tmpdir(), `${provider}-fixture-`));
  const cwd = options.cwd ?? join(tempDir, "repo");
  mkdirSync(cwd, { recursive: true });
  initGitRepo(cwd, options.branch ?? `feature/${provider}-fixture`);

  if (provider === "cursor") {
    const sessionId = options.sessionId ?? "cursor-session";
    const projectsRoot = join(homedir(), ".cursor/projects");
    const sourcePath = writeCursorTranscript(projectsRoot, sessionId, cwd);
    return {
      cwd,
      sourcePath,
      cleanup: () => {
        rmSync(dirname(dirname(sourcePath)), { recursive: true, force: true });
        rmSync(tempDir, { recursive: true, force: true });
      },
      adapterOptions: { cursorProjectsRoot: projectsRoot },
      rawHookPayload: {
        hook_event_name: "afterAgentResponse",
        cwd,
        conversation_id: sessionId,
        generation_id: options.turnId ?? "cursor-message-2",
        model: "composer-2.5-fast",
        transcript_path: sourcePath,
      },
    };
  }

  if (provider === "claude-code") {
    const sessionId = options.sessionId ?? "claude-session-id";
    const projectsRoot = join(homedir(), ".claude/projects");
    const sourcePath = writeClaudeTranscript(projectsRoot, sessionId, cwd);
    return {
      cwd,
      sourcePath,
      cleanup: () => {
        rmSync(dirname(sourcePath), { recursive: true, force: true });
        rmSync(tempDir, { recursive: true, force: true });
      },
      adapterOptions: { claudeProjectsRoot: projectsRoot },
      rawHookPayload: {
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: sourcePath,
      },
    };
  }

  const sessionId = options.sessionId ?? "codex-thread-id";
  const sourcePath = writeFixtureFile(
    tempDir,
    "codex-session.sanitized.jsonl",
    "codex-thread-id.jsonl",
  );
  const dbPath = join(tempDir, "state.sqlite");
  createCodexStateDb(dbPath, cwd, sessionId, sourcePath);
  return {
    cwd,
    sourcePath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    adapterOptions: { codexStateDbPath: dbPath },
    rawHookPayload: {
      hook_event_name: "Stop",
      cwd,
      session_id: sessionId,
      turn_id: options.turnId ?? "turn-id-1",
      transcript_path: sourcePath,
    },
  };
}

function writeCursorTranscript(
  projectsRoot: string,
  id: string,
  cwd: string,
): string {
  const dir = join(
    projectsRoot,
    encodeCursorProjectPath(cwd),
    "agent-transcripts",
    id,
  );
  return writeFixtureFile(
    dir,
    "cursor-agent-transcript.sanitized.jsonl",
    `${id}.jsonl`,
  );
}

function writeClaudeTranscript(
  projectsRoot: string,
  id: string,
  cwd: string,
): string {
  const dir = join(projectsRoot, encodeClaudeProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const content = readFixture("claude-code-session.sanitized.jsonl").replaceAll(
    "/repo/path",
    cwd,
  );
  writeFileSync(path, content);
  return path;
}

function writeFixtureFile(
  targetDir: string,
  fixtureName: string,
  fileName: string,
): string {
  mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, fileName);
  writeFileSync(path, readFixture(fixtureName));
  return path;
}

function readFixture(name: string): string {
  const roots = [
    resolve(process.cwd(), "__fixtures__/agent-traces"),
    resolve(process.cwd(), "../__fixtures__/agent-traces"),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../__fixtures__/agent-traces",
    ),
  ];
  const root = roots.find((root) => existsSync(join(root, name)));
  if (!root) {
    throw new Error(`Agent trace fixture not found: ${name}`);
  }
  return readFileSync(join(root, name), "utf8");
}

function initGitRepo(cwd: string, branch: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd });
  writeFileSync(join(cwd, ".gitkeep"), "");
  execFileSync("git", ["add", ".gitkeep"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd },
  );
}

function createCodexStateDb(
  dbPath: string,
  cwd: string,
  id: string,
  rolloutPath: string,
): void {
  const statements = [
    [
      "CREATE TABLE threads(",
      "id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER,",
      "updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,",
      "source TEXT, thread_source TEXT, model_provider TEXT, cwd TEXT,",
      "title TEXT, git_sha TEXT, git_branch TEXT, git_origin_url TEXT,",
      "cli_version TEXT, first_user_message TEXT, agent_nickname TEXT,",
      "agent_role TEXT, memory_mode TEXT, model TEXT, reasoning_effort TEXT,",
      "preview TEXT, archived INTEGER NOT NULL DEFAULT 0",
      ");",
    ].join(" "),
    [
      "INSERT INTO threads(",
      "id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,",
      "source, thread_source, model_provider, cwd, title, git_sha, git_branch,",
      "git_origin_url, cli_version, first_user_message, memory_mode, model,",
      "reasoning_effort, preview, archived",
      ") VALUES (",
      [
        sql(id),
        sql(rolloutPath),
        "1770000000",
        "1770000006",
        "1770000000000",
        "1770000006000",
        sql("cli"),
        sql("user"),
        sql("openai"),
        sql(cwd),
        sql("SANITIZED_TITLE"),
        sql("abcdef123456"),
        sql("feature/codex-native"),
        sql("https://example.invalid/codex.git"),
        sql("codex-cli 0.133.0"),
        sql("SANITIZED_USER_TEXT"),
        sql("enabled"),
        sql("gpt-5.5"),
        sql("medium"),
        sql("SANITIZED_PREVIEW"),
        "0",
      ].join(", "),
      ");",
    ].join(" "),
  ];
  execFileSync("sqlite3", [dbPath, statements.join("\n")]);
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
