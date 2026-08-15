import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as agentscope from "../index.js";
import { encodeClaudeProjectPath } from "../../native-traces/index.js";
import type { NativeTracePart } from "../../native-traces/index.js";

const SKILL_TEXT =
  "Base directory for this skill: /Users/x/repo/.claude/skills/testing\n\n# Testing\nrules...";

const SESSION_ID = "claude-meta-session";
const CWD = "/repo/path";

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
  text: string,
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
      content: [{ type: "text", text }],
    },
  };
}

async function partsForMetaRecord(
  metaOverrides: Record<string, unknown>,
): Promise<NativeTracePart[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-meta-"));
  const projectsRoot = join(tempDir, "claude-projects");
  const dir = join(projectsRoot, encodeClaudeProjectPath(CWD));
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, `${SESSION_ID}.jsonl`);

  const records = [
    userRecord("uuid-real-user", null, "2026-08-06T00:00:00.000Z"),
    userRecord("uuid-meta", "uuid-real-user", "2026-08-06T00:00:01.000Z", {
      isMeta: true,
      ...metaOverrides,
    }),
    assistantRecord(
      "uuid-assistant",
      "uuid-meta",
      "2026-08-06T00:00:02.000Z",
      "final answer",
    ),
  ];

  writeFileSync(
    sourcePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const result = await agentscope.claude.buildNativeTurnTrace(
    { sessionId: SESSION_ID, sourcePath },
    { adapterOptions: { claudeProjectsRoot: projectsRoot } },
  );

  return result.trace.messages.flatMap((message) => message.parts);
}

test("isMeta skill injection becomes skill_content attachment, not user_text", async () => {
  const parts = await partsForMetaRecord({
    message: { role: "user", content: [{ type: "text", text: SKILL_TEXT }] },
  });
  const skillMetaTexts = parts.filter(
    (part) => part.type === "user_text" && part.text === SKILL_TEXT,
  );
  assert.equal(skillMetaTexts.length, 0);
  const att = parts.find(
    (part) => part.type === "attachment" && part.name === "skill_content",
  );
  assert.ok(att, "expected a skill_content attachment part");
  assert.equal(att?.type, "attachment");
  if (att?.type === "attachment") {
    assert.equal(
      (att.value as { path: string }).path,
      "/Users/x/repo/.claude/skills/testing",
    );
  }
});

test("non-meta user text is unchanged", async () => {
  const parts = await partsForMetaRecord({ isMeta: false });
  assert.ok(
    parts.some((part) => part.type === "user_text"),
    "expected at least one user_text part",
  );
});

test("isMeta non-skill text becomes meta_text attachment", async () => {
  const parts = await partsForMetaRecord({
    message: { role: "user", content: "[Image: x]" },
  });
  const imagePlaceholderAsUserText = parts.filter(
    (part) => part.type === "user_text" && part.text === "[Image: x]",
  );
  assert.equal(imagePlaceholderAsUserText.length, 0);
  const att = parts.find(
    (part) => part.type === "attachment" && part.name === "meta_text",
  );
  assert.ok(att, "expected a meta_text attachment part");
});
