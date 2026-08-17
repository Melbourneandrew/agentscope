import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import * as agentscope from "../index.js";
import { encodeClaudeProjectPath } from "../../native-traces/index.js";

const SESSION_ID = "s1";
const CWD = "/repo/path";

const SKILL_BASE_TEXT =
  "Base directory for this skill: /r/.claude/skills/testing\n...";

function userRecord(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp,
    cwd: CWD,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
    ...overrides,
  };
}

function assistantRecord(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp,
    cwd: CWD,
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-model",
      ...overrides,
    },
  };
}

test("turn containing a Skill invocation is not truncated at the injection", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "skill-truncation-"));
  const projectsRoot = join(tempDir, "claude-projects");
  const dir = join(projectsRoot, encodeClaudeProjectPath(CWD));
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, `${SESSION_ID}.jsonl`);

  // Build fixture transcript:
  // 1. user: "fix the bug please"
  // 2. assistant: tool_use Skill invocation
  // 3. user: tool_result for Skill
  // 4. user with isMeta: true: skill injection text
  // 5. assistant: "done"

  const records = [
    userRecord("uuid-1", null, "2026-08-06T00:00:00.000Z", {
      message: {
        role: "user",
        content: [{ type: "text", text: "fix the bug please" }],
      },
    }),
    assistantRecord("uuid-2", "uuid-1", "2026-08-06T00:00:01.000Z", {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Skill",
          input: { skill: "testing" },
        },
      ],
    }),
    userRecord("uuid-3", "uuid-2", "2026-08-06T00:00:02.000Z", {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "Launching skill: testing",
          },
        ],
      },
    }),
    userRecord("uuid-4", "uuid-3", "2026-08-06T00:00:03.000Z", {
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: SKILL_BASE_TEXT }],
      },
    }),
    assistantRecord("uuid-5", "uuid-4", "2026-08-06T00:00:04.000Z", {
      content: [{ type: "text", text: "done" }],
    }),
  ];

  writeFileSync(
    sourcePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const { trace } = await agentscope.claude.buildNativeTurnTrace(
    { sessionId: SESSION_ID, sourcePath },
    { adapterOptions: { claudeProjectsRoot: projectsRoot } },
  );

  // Verify Skill tool_call is present (was sliced out before Task 2)
  const toolNames = trace.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool_call")
    .map((p) => p.call.name);
  assert.ok(toolNames.includes("Skill"), "expected Skill tool_call in trace");

  // Verify initial user message is still present (not truncated)
  const firstUser = trace.messages.find((m) =>
    m.parts.some((p) => p.type === "user_text"),
  );
  assert.ok(
    firstUser?.parts.some(
      (p) => p.type === "user_text" && p.text === "fix the bug please",
    ),
    "expected initial user message 'fix the bug please' to be present",
  );
});
