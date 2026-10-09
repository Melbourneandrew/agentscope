import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { createHash } from "node:crypto";
export const correlateClaudeModelControl = (rows, clientEntries, denials) => {
  const sent = [
    ...clientEntries.slice(0, 1),
    ...denials,
    ...clientEntries.slice(1),
  ];
  let index = 0;
  const traffic = rows.map((row) => {
    if (row.role !== undefined && row.role !== "data-plane") {
      const actual = sent[index++];
      if (
        actual === undefined ||
        Object.keys(actual).some((key) => actual[key] !== row[key])
      )
        throw new Error("integration.claude-code.model-control");
      return actual;
    }
    return {
      method: row.method,
      path: row.path,
      role: "data-plane",
      status: 200,
      bodyBytes: row.bodyBytes,
      bodySha256: row.bodySha256,
    };
  });
  if (index !== sent.length)
    throw new Error("integration.claude-code.model-control");
  return traffic;
};
export const claudeModelLedger = (rows, routes, scenarioId) => ({
  ledgerVersion: 1,
  scenarioId,
  entries: rows
    .filter((row) => row.role === undefined || row.role === "data-plane")
    .map((row) => {
      const matches = routes.routes.filter(
        (route) => route.method === row.method && route.path === row.path,
      );
      if (matches.length !== 1)
        throw new Error("integration.claude-code.model-route");
      const index = routes.routes.indexOf(matches[0]);
      return {
        routeId: routes.routeIds[index],
        provider: matches[0].provider,
        method: row.method,
        path: row.path,
        bodyBytes: row.bodyBytes,
      };
    }),
});

const assert = (condition, code) => {
  if (!condition) throw new Error(`integration.claude-code.oracle-${code}`);
};

const claudeRequestBody = (body) => {
  const text =
    typeof body === "string"
      ? body
      : body?.type === "STRING"
        ? body.string
        : body?.type === "JSON"
          ? body.json
          : undefined;
  assert(
    typeof text === "string" && Buffer.byteLength(text) <= 65536,
    "model-body",
  );
  const value = JSON.parse(text);
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "model-body",
  );
  assert(
    value.stream === true &&
      typeof value.model === "string" &&
      value.model.length > 0 &&
      value.model.length <= 256,
    "model-body",
  );
  assert(
    Array.isArray(value.messages) && value.messages.length <= 3,
    "model-messages",
  );
  return { value, digest: createHash("sha256").update(text).digest("hex") };
};
const claudeMessageBlocks = (message, role) => {
  assert(
    message !== null &&
      typeof message === "object" &&
      message.role === role &&
      Array.isArray(message.content) &&
      message.content.length >= 1 &&
      message.content.length <= 16,
    "model-message",
  );
  assert(
    message.content.every(
      (block) =>
        block !== null && typeof block === "object" && !Array.isArray(block),
    ),
    "model-message",
  );
  return message.content;
};
const inspectClaudeReadRequestPair = (first, second, stimulus) => {
  assert(
    second.value.model === first.value.model &&
      second.value.messages.length === 3 &&
      JSON.stringify(second.value.messages[0]) ===
        JSON.stringify(first.value.messages[0]),
    "model-second",
  );
  const tools = claudeMessageBlocks(second.value.messages[1], "assistant");
  const results = claudeMessageBlocks(second.value.messages[2], "user");
  assert(
    tools.length === 1 &&
      tools[0].type === "tool_use" &&
      tools[0].id === "toolu_agentscope_claude_read_1" &&
      tools[0].name === "Read" &&
      tools[0].input?.file_path === stimulus.path,
    "model-tool",
  );
  assert(
    results.length === 1 &&
      results[0].type === "tool_result" &&
      results[0].tool_use_id === tools[0].id &&
      results[0].is_error !== true,
    "model-tool-result",
  );
};

// Parse only the bounded, authenticated upstream retrieval response. Bodies
// are discarded after comparing the actual native primary request pair; the
// caller retains the FULL ledger separately, including auxiliary requests.
export const inspectClaudeCodeModelRequests = (bytes, stimulus) => {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024,
    "model-ledger",
  );
  const records = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  assert(Array.isArray(records) && records.length <= 16, "model-ledger");
  assert(
    records.every(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof row.method === "string" &&
        typeof row.path === "string",
    ),
    "model-ledger",
  );
  const primary = records.filter(
    (row) => row.method === "POST" && row.path === "/v1/messages",
  );
  assert(primary.length <= 2, "model-primary-count");
  if (primary.length === 0) return undefined;
  const first = claudeRequestBody(primary[0].body);
  assert(first.value.messages.length === 1, "model-first");
  const prompt = claudeMessageBlocks(first.value.messages[0], "user");
  assert(
    prompt.filter(
      (block) => block.type === "text" && block.text === stimulus.prompt,
    ).length === 1,
    "model-first",
  );
  if (primary.length === 1) return undefined;
  const second = claudeRequestBody(primary[1].body);
  inspectClaudeReadRequestPair(first, second, stimulus);
  return Object.freeze({
    modelRequestBodySha256: Object.freeze([first.digest, second.digest]),
  });
};
// Called only after the official child is terminally joined. Raw native bodies
// remain ephemeral; these independently observed facts are not hook payloads.
export const observeClaudeCodeNativeTurn = (claudeCodeReadStimulus) => {
  const opened = [];
  const openDirectory = (path) => {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    opened.push(descriptor);
    if (!fstatSync(descriptor).isDirectory())
      throw new Error("integration.claude-code.native-directory");
    return descriptor;
  };
  try {
    const home = openDirectory("/harness-home");
    const projects = openDirectory(`/proc/self/fd/${home}/projects`);
    const project = openDirectory(`/proc/self/fd/${projects}/-worktree`);
    const entries = readdirSync(`/proc/self/fd/${project}`);
    if (entries.length > 8)
      throw new Error("integration.claude-code.native-inventory");
    const files = entries.filter((entry) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jsonl$/u.test(
        entry,
      ),
    );
    if (files.length !== 1)
      throw new Error("integration.claude-code.native-inventory");
    const path = `/proc/self/fd/${project}/${files[0]}`;
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    opened.push(descriptor);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== 1000 ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > 1024 * 1024
    )
      throw new Error("integration.claude-code.native-file");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(descriptor),
      named = lstatSync(path);
    if (
      length !== before.size ||
      [after, named].some((identity) =>
        [
          "dev",
          "ino",
          "size",
          "mode",
          "uid",
          "nlink",
          "mtimeMs",
          "ctimeMs",
        ].some((key) => identity[key] !== before[key]),
      )
    )
      throw new Error("integration.claude-code.native-identity");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    if (!text.endsWith("\n"))
      throw new Error("integration.claude-code.native-jsonl");
    const lines = text.slice(0, -1).split("\n");
    if (
      lines.length > 128 ||
      lines.some((line) => Buffer.byteLength(line) > 65536)
    )
      throw new Error("integration.claude-code.native-jsonl");
    return inspectClaudeCodeNativeRecords(
      lines.map((line) => JSON.parse(line)),
      files[0].slice(0, -6),
      claudeCodeReadStimulus,
    );
  } finally {
    for (const descriptor of opened.reverse()) closeSync(descriptor);
  }
};

const assertClaudeNativeRecord = (record, sessionId) => {
  if (
    record.sessionId !== sessionId ||
    record.cwd !== "/worktree" ||
    record.version !== "2.1.245" ||
    record.isSidechain !== false ||
    record.message === null ||
    typeof record.message !== "object"
  )
    throw new Error("integration.claude-code.native-record");
};
const observeClaudeNativeModel = (record, model) => {
  if (record.type !== "assistant" || record.message.model === undefined)
    return model;
  const observed = record.message.model;
  if (
    typeof observed !== "string" ||
    observed.length < 1 ||
    observed.length > 256 ||
    (model !== undefined && model !== observed)
  )
    throw new Error("integration.claude-code.native-model");
  return observed;
};
const inspectClaudeNativeBlock = (
  block,
  type,
  index,
  state,
  claudeCodeReadStimulus,
) => {
  if (block === null || typeof block !== "object")
    throw new Error("integration.claude-code.native-content");
  if (type === "assistant" && block.type === "tool_use") {
    if (
      state.toolIndex !== -1 ||
      block.id !== "toolu_agentscope_claude_read_1" ||
      block.name !== "Read" ||
      block.input?.file_path !== claudeCodeReadStimulus.path
    )
      throw new Error("integration.claude-code.native-tool");
    state.toolIndex = index;
  }
  if (type === "user" && block.type === "tool_result") {
    if (
      state.resultIndex !== -1 ||
      block.tool_use_id !== "toolu_agentscope_claude_read_1" ||
      block.is_error === true
    )
      throw new Error("integration.claude-code.native-tool-result");
    state.resultIndex = index;
  }
  if (type === "assistant" && block.type === "text" && block.text === "DONE")
    state.finalIndex = index;
};
const inspectClaudeCodeNativeRecords = (
  records,
  sessionId,
  claudeCodeReadStimulus,
) => {
  const state = { toolIndex: -1, resultIndex: -1, finalIndex: -1 };
  let promptSeen = false;
  let model;
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record))
      throw new Error("integration.claude-code.native-record");
    if (record.type !== "user" && record.type !== "assistant") continue;
    assertClaudeNativeRecord(record, sessionId);
    const { content } = record.message;
    if (record.type === "user" && typeof content === "string") {
      if (content === claudeCodeReadStimulus.prompt) promptSeen = true;
      continue;
    }
    if (!Array.isArray(content) || content.length > 16)
      throw new Error("integration.claude-code.native-content");
    model = observeClaudeNativeModel(record, model);
    for (const block of content)
      inspectClaudeNativeBlock(
        block,
        record.type,
        index,
        state,
        claudeCodeReadStimulus,
      );
  }
  if (
    !promptSeen ||
    state.toolIndex < 0 ||
    state.resultIndex <= state.toolIndex ||
    state.finalIndex <= state.resultIndex
  )
    throw new Error("integration.claude-code.native-turn");
  return Object.freeze({
    nativeSessionId: sessionId,
    nativeToolUseId: "toolu_agentscope_claude_read_1",
    ...(model === undefined ? {} : { nativeModelName: model }),
  });
};

// This is one native correlation predicate, not a complete scenario result or
// admission receipt. Same-run execution and independently decoded OTLP facts
// must still be joined by the existing controller-owned oracle boundary.
export const inspectClaudeCodeHookLifecycle = (hooks) => {
  assert(
    Array.isArray(hooks) && hooks.length >= 4 && hooks.length <= 128,
    "hooks",
  );
  const session = hooks[0].sessionId;
  assert(hooks[0].eventName === "SessionStart", "session-start");
  const pending = new Map();
  const completed = new Set();
  for (let index = 1; index < hooks.length - 1; index += 1) {
    const hook = hooks[index];
    assert(hook.sessionId === session, "session-correlation");
    assert(
      typeof hook.toolUseId === "string" && hook.toolUseId.length > 0,
      "tool-id",
    );
    if (hook.eventName === "PreToolUse") {
      assert(
        !pending.has(hook.toolUseId) && !completed.has(hook.toolUseId),
        "duplicate-tool",
      );
      pending.set(hook.toolUseId, hook);
    } else {
      assert(hook.eventName === "PostToolUse", "unexpected-boundary");
      const start = pending.get(hook.toolUseId);
      assert(
        start !== undefined && start.toolName === hook.toolName,
        "tool-correlation",
      );
      pending.delete(hook.toolUseId);
      completed.add(hook.toolUseId);
    }
  }
  const stop = hooks.at(-1);
  assert(stop.sessionId === session && stop.eventName === "Stop", "stop");
  assert(stop.stopHookActive === false, "recursive-stop");
  assert(completed.size > 0 && pending.size === 0, "incomplete-tool");
  return Object.freeze({
    sessionId: session,
    toolUseIds: Object.freeze([...completed]),
    hookEventCount: hooks.length,
    nativeSessionEnd: null,
  });
};

// The fixed provider stimulus requires exactly one Read pair. This adds only
// expected native facts; actual model-request and OTLP joins remain mandatory
// at the existing outer oracle boundary, not replaced by this predicate.
export const inspectClaudeCodeReadHookTurn = (hooks) => {
  const observed = inspectClaudeCodeHookLifecycle(hooks);
  assert(hooks.length === 4, "read-boundaries");
  assert(
    hooks[1].toolName === "Read" && hooks[2].toolName === "Read",
    "read-tool",
  );
  assert(
    observed.toolUseIds.length === 1 &&
      observed.toolUseIds[0] === "toolu_agentscope_claude_read_1",
    "read-model-id",
  );
  return observed;
};
