import assert from "node:assert/strict";
import test from "node:test";

import { deriveDisplayState, filterGraph, layoutGraph, normalizeIssues } from "./graph.mjs";
import { BD_LIST_ARGUMENTS, loadGraph, parsePort } from "./server.mjs";

const fixtures = [
  { id: "a", title: "Foundation", status: "closed", priority: 1 },
  {
    id: "b",
    title: "Build feature",
    status: "open",
    priority: 0,
    labels: ["alpha"],
    dependencies: [{ issue_id: "b", depends_on_id: "a", type: "blocks" }],
  },
  {
    id: "c",
    title: "Ship feature",
    status: "open",
    priority: 2,
    dependencies: [{ issue_id: "c", depends_on_id: "b", type: "blocks" }],
  },
];

test("normalizes dependency direction from prerequisite to dependent", () => {
  const graph = normalizeIssues(fixtures);
  assert.deepEqual(
    graph.edges.map(({ source, target, type }) => ({ source, target, type })),
    [
      { source: "a", target: "b", type: "blocks" },
      { source: "b", target: "c", type: "blocks" },
    ],
  );
  assert.equal(graph.nodes.find((node) => node.id === "b").displayState, "ready");
  assert.equal(graph.nodes.find((node) => node.id === "c").displayState, "blocked");
});

test("derives every visible workflow state without weakening explicit status", () => {
  assert.equal(deriveDisplayState("open", 0), "ready");
  assert.equal(deriveDisplayState("open", 1), "blocked");
  assert.equal(deriveDisplayState("blocked", 0), "blocked");
  assert.equal(deriveDisplayState("in_progress", 2), "in-progress");
  assert.equal(deriveDisplayState("closed", 2), "closed");
  assert.equal(deriveDisplayState("deferred", 0), "deferred");
});

test("filters by search, status, priority and focused dependency neighborhood", () => {
  const graph = normalizeIssues(fixtures);
  const filtered = filterGraph(graph, {
    query: "feature",
    statuses: ["ready", "blocked"],
    priorities: [0, 2],
    relationshipTypes: ["blocks"],
    focusId: "b",
    focusDepth: 1,
  });
  assert.deepEqual(
    filtered.nodes.map((node) => node.id).sort(),
    ["b", "c"],
  );
  assert.deepEqual(filtered.edges, [{ source: "b", target: "c", type: "blocks" }]);
});

test("lays prerequisites before dependents", () => {
  const graph = normalizeIssues(fixtures);
  const layout = layoutGraph(graph);
  assert.ok(layout.positions.get("a").x < layout.positions.get("b").x);
  assert.ok(layout.positions.get("b").x < layout.positions.get("c").x);
});

test("handles empty and malformed data without throwing", () => {
  assert.deepEqual(normalizeIssues([]), { nodes: [], edges: [], warnings: [] });
  assert.equal(normalizeIssues({}).warnings.length, 1);
  const graph = normalizeIssues([null, { id: "", title: "bad" }, { id: "ok", title: "Good", dependencies: [{}] }]);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["ok"]);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.warnings.length, 3);
});

test("reads only through the supported read-only bd list command", async () => {
  assert.deepEqual(BD_LIST_ARGUMENTS, ["list", "--all", "--flat", "--limit", "0", "--json", "--readonly"]);
  let call;
  const graph = await loadGraph(async (...arguments_) => {
    call = arguments_;
    return { stdout: JSON.stringify(fixtures) };
  });
  assert.equal(call[0], "bd");
  assert.deepEqual(call[1], BD_LIST_ARGUMENTS);
  assert.equal(graph.nodes.length, 3);
});

test("rejects malformed bd output and unsafe port arguments", async () => {
  await assert.rejects(() => loadGraph(async () => ({ stdout: "not-json" })), /malformed JSON/);
  assert.equal(parsePort([]), 4173);
  assert.equal(parsePort(["--port", "8000"]), 8000);
  assert.throws(() => parsePort(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parsePort(["--host", "0.0.0.0"]), /Usage/);
});
