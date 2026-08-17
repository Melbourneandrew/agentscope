import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  NativeAgentTrace,
  NativeTraceMessage,
  NativeTracePart,
} from "../types.js";
import { detectSkillUsage, normalizeSkillPath } from "../skill-usage.js";

function msg(
  providerIds: Record<string, string>,
  parts: NativeTracePart[],
): NativeTraceMessage {
  return { id: "m1", role: "assistant", providerIds, parts };
}

function traceWithMessages(messages: NativeTraceMessage[]): NativeAgentTrace {
  return { id: "t", provider: "claude-code", messages, sources: [] };
}

function traceWith(parts: NativeTracePart[]): NativeAgentTrace {
  return traceWithMessages([{ id: "m1", role: "assistant", parts }]);
}

test("normalizes plugin-cache paths to plugin:name", () => {
  assert.equal(
    normalizeSkillPath(
      "/Users/x/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/brainstorming",
    ),
    "superpowers:brainstorming",
  );
  assert.equal(
    normalizeSkillPath("/repo/.cursor/skills/testing/SKILL.md"),
    "testing",
  );
});

test("detects Skill tool_call", () => {
  const usages = detectSkillUsage(
    traceWith([
      {
        type: "tool_call",
        call: { id: "t1", name: "Skill", input: { skill: "qa" } },
      },
    ]),
  );
  assert.deepEqual(usages, [{ name: "qa", detection: "tool-call" }]);
});

test("detects skill_content attachment (injection)", () => {
  const usages = detectSkillUsage(
    traceWith([
      {
        type: "attachment",
        name: "skill_content",
        value: { path: "/r/.claude/skills/review", text: "..." },
      },
    ]),
  );
  assert.deepEqual(usages, [{ name: "review", detection: "injection" }]);
});

test("detects SKILL.md file reads in shell commands and tool inputs", () => {
  const usages = detectSkillUsage(
    traceWith([
      {
        type: "shell_command",
        command: {
          command: "sed -n '1,120p' /r/.cursor/skills/migrations/SKILL.md",
        },
      },
      {
        type: "tool_call",
        call: {
          id: "t2",
          name: "Read",
          input: { file_path: "/r/.cursor/skills/testing/SKILL.md" },
        },
      },
    ]),
  );
  assert.deepEqual(usages.map((u) => u.name).sort(), ["migrations", "testing"]);
  assert.ok(usages.every((u) => u.detection === "file-read"));
});

test("dedupes per skill keeping highest-priority detection", () => {
  const usages = detectSkillUsage(
    traceWithMessages([
      msg({ claude_attribution_skill: "qa" }, [
        {
          type: "tool_call",
          call: { id: "t1", name: "Skill", input: { skill: "qa" } },
        },
      ]),
    ]),
  );
  assert.deepEqual(usages, [{ name: "qa", detection: "attribution" }]);
});
