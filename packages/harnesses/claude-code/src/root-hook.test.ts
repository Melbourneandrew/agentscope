import { isSemanticCandidateUpstreamConstraintValid } from "@agentscope/protocol";
import { describe, expect, it } from "vitest";

import { decodeClaudeCodeRootHookInput } from "./root-hook.js";
import { mapClaudeCodeRootHookCapture } from "./mapping.js";

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const common = {
  session_id: "session-1",
  cwd: "/workspace",
  transcript_path: "/not-read.jsonl",
};
const stop = { ...common, hook_event_name: "Stop", stop_hook_active: false };
const decode = (value: unknown) => decodeClaudeCodeRootHookInput(encode(value));

describe("Claude 2.1.245 root-hook observations", () => {
  it.each([
    {
      ...common,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "observed-model",
    },
    {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: {},
    },
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: {},
      tool_response: { text: "bounded" },
      duration_ms: 1,
    },
    stop,
    { ...common, hook_event_name: "SessionEnd", reason: "other" },
  ])(
    "maps the actual $hook_event_name shape through the semantic profile",
    (input) => {
      const hook = decode(input);
      const candidate = mapClaudeCodeRootHookCapture(hook);
      expect(candidate.rootContext.fields[0]?.value).toBe("session-1");
      expect(candidate.captureBoundary.session).toEqual({
        kind: "attempt-scoped",
      });
      const operation = candidate.operations.at(-1)!;
      const roots = candidate.operations.filter(
        (entry) => !("parentLogicalKey" in entry),
      );
      expect(roots).toHaveLength(1);
      expect(roots[0]?.kind).toBe("AGENT");
      expect(
        new Set(candidate.operations.map(({ logicalKey }) => logicalKey)).size,
      ).toBe(candidate.operations.length);
      if (operation !== roots[0]) {
        expect(operation).toHaveProperty(
          "parentLogicalKey",
          roots[0]?.logicalKey,
        );
        expect(roots[0]?.name).toBe("claude.hook-invocation");
        expect(roots[0]?.locator).toEqual({
          kind: "source-ordinal",
          ordinal: 0,
        });
        expect(roots[0]).not.toHaveProperty("timing");
        expect(roots[0]?.fields).toEqual([]);
      }
      expect(
        new Set(
          candidate.operations
            .filter(({ locator }) => locator.kind === "source-ordinal")
            .map(({ locator }) => JSON.stringify(locator)),
        ).size,
      ).toBe(
        candidate.operations.filter(
          ({ locator }) => locator.kind === "source-ordinal",
        ).length,
      );
      expect(
        isSemanticCandidateUpstreamConstraintValid({
          kind: operation.kind,
          spanName: operation.name,
          presentFields: operation.fields.map(({ field }) => field),
          unavailable: operation.unavailable,
        }),
      ).toBe(true);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(operation.fields)).toBe(true);
      expect(hook.workspacePath).toBe("/workspace");
    },
  );

  it("does not invent a model or turn from a session/prompt/transcript", () => {
    const candidate = mapClaudeCodeRootHookCapture(
      decode({
        ...stop,
        prompt_id: "prompt-1",
        last_assistant_message: "synthetic-output",
      }),
    );
    expect(candidate.operations.at(-1)?.locator).toEqual({
      kind: "source-ordinal",
      ordinal: 1,
    });
    expect(candidate.operations.at(-1)?.unavailable).toContainEqual({
      field: "llm.model_name",
      source: "hook-payload",
      state: "unavailable",
      reason: "not-emitted",
    });
    expect(candidate.operations.at(-1)?.fields[0]?.value).toBe(
      "synthetic-output",
    );
    expect(JSON.stringify(candidate)).not.toContain("not-read.jsonl");
    expect(JSON.stringify(candidate)).not.toContain("prompt-1");
  });
});

describe("Claude malformed native input", () => {
  it.each([
    {},
    { ...stop, session_id: "" },
    { ...stop, cwd: "relative" },
    { ...stop, hook_event_name: "Unknown" },
    { ...stop, stop_hook_active: 1 },
    { ...stop, transcript_path: 1 },
    { ...stop, transcript_path: "x".repeat(4097) },
    { ...stop, turn_id: "codex-turn" },
    { ...stop, model: "codex-model" },
    { ...stop, prompt_id: null },
    { ...stop, last_assistant_message: {} },
    { ...stop, session_id: "x\u0000y" },
    { ...stop, session_id: "\ud800" },
    { ...stop, last_assistant_message: "x".repeat(32769) },
    {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: 1,
    },
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: {},
    },
    { ...common, hook_event_name: "SessionStart" },
    { ...common, hook_event_name: "SessionEnd", reason: false },
  ])("rejects malformed native input %#", (input) => {
    expect(() => decode(input)).toThrow("claude-code.mapping.invalid");
  });
});

describe("Claude emitted metadata preservation", () => {
  it("preserves a session model without inventing an LLM call", () => {
    const hook = decode({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "native-model",
    });
    expect(hook.model).toBe("native-model");
    expect(mapClaudeCodeRootHookCapture(hook).operations.at(-1)?.kind).toBe(
      "AGENT",
    );
  });
  it("maps owned deeply frozen native tool IO and preserves duration", () => {
    const source = {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: { paths: ["original"] },
      tool_response: { content: [{ text: "native-output" }] },
      duration_ms: 0.5,
    };
    const hook = decode(source);
    source.tool_input.paths[0] = "changed";
    expect(hook.durationMilliseconds).toBe(0.5);
    expect(Object.isFrozen(hook.toolInput)).toBe(true);
    expect(
      Object.isFrozen(Reflect.get(hook.toolInput as object, "paths")),
    ).toBe(true);
    expect(Object.isFrozen(hook.toolResponse)).toBe(true);
    const operation = mapClaudeCodeRootHookCapture(hook).operations.at(-1)!;
    expect(operation.fields).toContainEqual({
      field: "input.value",
      value: '{"paths":["original"]}',
      provenance: { field: "input.value", source: "hook-payload" },
    });
    expect(operation.fields).toContainEqual({
      field: "output.value",
      value: '{"content":[{"text":"native-output"}]}',
      provenance: { field: "output.value", source: "hook-payload" },
    });
    expect(
      operation.fields
        .filter(({ field }) => field.endsWith("mime_type"))
        .map(({ value }) => value),
    ).toEqual(["application/json", "application/json"]);
    expect(
      isSemanticCandidateUpstreamConstraintValid({
        kind: operation.kind,
        spanName: operation.name,
        presentFields: operation.fields.map(({ field }) => field),
        unavailable: operation.unavailable,
      }),
    ).toBe(true);
    expect(operation).not.toHaveProperty("timing");
  });
  it("distinguishes emitted null response from a pre-tool absent response", () => {
    const pre = {
      ...common,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "tool-1",
      tool_input: {},
    };
    expect(decode(pre).toolResponsePresent).toBe(false);
    const post = decode({
      ...pre,
      hook_event_name: "PostToolUse",
      tool_response: null,
    });
    expect(post.toolResponsePresent).toBe(true);
    expect(
      mapClaudeCodeRootHookCapture(post).operations.at(-1)?.fields,
    ).toContainEqual({
      field: "output.value",
      value: "null",
      provenance: { field: "output.value", source: "hook-payload" },
    });
  });
  it.each([null, 1, "", "x".repeat(257)])(
    "rejects malformed model %#",
    (model) => {
      expect(() =>
        decode({
          ...common,
          hook_event_name: "SessionStart",
          source: "startup",
          model,
        }),
      ).toThrow();
    },
  );
  it.each([null, "1", -1])("rejects malformed duration %#", (duration_ms) => {
    expect(() =>
      decode({
        ...common,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "tool-1",
        tool_input: {},
        tool_response: {},
        duration_ms,
      }),
    ).toThrow();
  });
});

describe("Claude root-hook framing and resource boundaries", () => {
  it.each([
    "",
    "{",
    "{}x",
    "[]",
    "null",
    "1e999",
    '"unterminated',
    '{"key":',
    '{"key" 1}',
    '{"key":1;}',
    "[true false]",
    "[1,]",
    '{"key":1,}',
    '{"key":01}',
    '{"key":unknown}',
    "\ufeff" + JSON.stringify(stop),
    '{"hook_event_name":"Stop","hook_event_name":"Stop"}',
    JSON.stringify(stop).replace(
      '"session_id"',
      '"session_id":"other","session_id"',
    ),
    JSON.stringify({
      ...stop,
      background_tasks: [{ duplicate: true }],
    }).replace('"duplicate":true', '"duplicate":true,"duplicate":false'),
    JSON.stringify({ ...stop, background_tasks: [[1]] }).replace(
      "[[1]]",
      "[".repeat(34) + "1" + "]".repeat(34),
    ),
    JSON.stringify({ ...stop, background_tasks: Array(4096).fill(null) }),
  ])("rejects invalid framing, duplicates and resource excess %#", (raw) => {
    expect(() =>
      decodeClaudeCodeRootHookInput(new TextEncoder().encode(raw)),
    ).toThrow("claude-code.mapping.invalid");
  });
  it("rejects oversized and invalid UTF-8 bytes", () => {
    expect(() =>
      decodeClaudeCodeRootHookInput(new Uint8Array(65537)),
    ).toThrow();
    expect(() =>
      decodeClaudeCodeRootHookInput(new Uint8Array([255])),
    ).toThrow();
  });
});

describe("Claude root-hook caller identity boundaries", () => {
  it("rejects proxies/subclasses before accessing caller hooks", () => {
    let effects = 0;
    const hostile = new Proxy(encode(stop), {
      get() {
        effects++;
        throw Error("must-not-run");
      },
      getPrototypeOf() {
        effects++;
        throw Error("must-not-run");
      },
    });
    expect(() => decodeClaudeCodeRootHookInput(hostile)).toThrow();
    class Hostile extends Uint8Array {
      override get byteLength(): never {
        effects++;
        throw Error("must-not-run");
      }
    }
    expect(() => decodeClaudeCodeRootHookInput(new Hostile(1))).toThrow();
    expect(effects).toBe(0);
  });
  it("copies exact bounded bytes without caller-owned accessors or aliases", () => {
    const bytes = encode(stop);
    let effects = 0;
    for (const key of [
      "byteLength",
      "constructor",
      "valueOf",
      Symbol.iterator,
    ]) {
      Object.defineProperty(bytes, key, {
        get() {
          effects++;
          throw Error("must-not-run");
        },
      });
    }
    const hook = decodeClaudeCodeRootHookInput(bytes);
    bytes.fill(0);
    expect(hook.sessionId).toBe("session-1");
    expect(effects).toBe(0);
    const raw = JSON.stringify({
      ...stop,
      background_tasks: [true, false, null, -1.5e2, 'escaped"text', {}, []],
    });
    const exact = new TextEncoder().encode(
      raw + " ".repeat(65536 - raw.length),
    );
    expect(decodeClaudeCodeRootHookInput(exact).eventName).toBe("Stop");
  });
  it("rejects unparsed clones and proxies without property observation", () => {
    const parsed = decode(stop);
    expect(() => mapClaudeCodeRootHookCapture({ ...parsed })).toThrow();
    let effects = 0;
    const hostile = new Proxy(parsed, {
      get() {
        effects++;
        throw Error("must-not-run");
      },
    });
    expect(() => mapClaudeCodeRootHookCapture(hostile)).toThrow();
    expect(effects).toBe(0);
  });
});
