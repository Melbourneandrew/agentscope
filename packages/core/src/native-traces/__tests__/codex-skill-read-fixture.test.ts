import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import * as agentscope from "../../native-turns/index.js";
import { detectSkillUsage } from "../skill-usage.js";

const SESSION_ID = "019fd90c-6f17-70a2-a065-0adcb57807bf";
const CWD = "/repo/path";

test("codex adapter surfaces a SKILL.md shell read as skill.<name> usage end-to-end", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-skill-read-fixture-"));
  const sourcePath = join(
    tempDir,
    `rollout-2026-08-06T17-48-18-${SESSION_ID}.jsonl`,
  );

  const records = [
    {
      timestamp: "2026-08-06T17:48:18.583Z",
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: CWD,
        model_provider: "openai",
        model: "gpt-5.5",
      },
    },
    {
      timestamp: "2026-08-06T17:48:19.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "please read the testing skill",
      },
    },
    {
      timestamp: "2026-08-06T17:48:20.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({
          cmd: "sed -n '1,100p' /repo/.cursor/skills/testing/SKILL.md",
        }),
      },
    },
    {
      timestamp: "2026-08-06T17:48:21.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: { output: "SKILL.md contents...", exit_code: 0 },
      },
    },
    {
      timestamp: "2026-08-06T17:48:22.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    },
  ];

  writeFileSync(
    sourcePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  try {
    const { trace } = await agentscope.codex.buildNativeTurnTrace(
      { sessionId: SESSION_ID, sourcePath },
      {
        adapterOptions: {
          codexStateDbPath: join(tempDir, "does-not-exist.sqlite"),
        },
      },
    );

    const usage = detectSkillUsage(trace);
    assert.deepEqual(usage, [{ name: "testing", detection: "file-read" }]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
