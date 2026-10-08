const assert = (condition, code) => {
  if (!condition) throw new Error(`integration.claude-code.oracle-${code}`);
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
