import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import {
  dashboardMessage,
  deriveDisplayState,
  displayIssueId,
  filterGraph,
  layoutGraph,
  normalizeIssues,
} from "./graph.mjs";
import { captureIssueFocus, restoreIssueFocus } from "./focus.mjs";
import {
  BD_BLOCKED_ARGUMENTS,
  BD_LIST_ARGUMENTS,
  BD_READY_ARGUMENTS,
  BD_STALE_ARGUMENTS,
  createDashboardServer,
  loadGraph,
  parsePort,
} from "./server.mjs";

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

test("treats parents as containers without making hierarchy a blocker", () => {
  const graph = normalizeIssues([
    { id: "agentscope-release-001", title: "Parent", status: "in_progress" },
    {
      id: "agentscope-release-002",
      title: "Child",
      status: "in_progress",
      dependencies: [
        { issue_id: "agentscope-release-002", depends_on_id: "agentscope-release-001", type: "parent-child" },
      ],
    },
  ]);
  const parent = graph.nodes.find((node) => node.id === "agentscope-release-001");
  const child = graph.nodes.find((node) => node.id === "agentscope-release-002");
  assert.equal(parent.isContainer, true);
  assert.equal(parent.workClass, "container");
  assert.equal(child.displayState, "active");
  assert.equal(child.workClass, "active-leaf");
  assert.equal(child.displayId, "release-002");
  assert.equal(displayIssueId("agentscope-vah.11.1"), "vah.11.1");
});

test("derives every visible workflow state without weakening explicit status", () => {
  assert.equal(deriveDisplayState("open", 0), "ready");
  assert.equal(deriveDisplayState("open", 1), "blocked");
  assert.equal(deriveDisplayState("blocked", 0), "blocked");
  assert.equal(deriveDisplayState("in_progress", 2, false, true), "blocked-active");
  assert.equal(deriveDisplayState("in_progress", 0, false, false, true), "stale-active");
  assert.equal(deriveDisplayState("in_progress", 0), "active");
  assert.equal(deriveDisplayState("closed", 2), "closed");
  assert.equal(deriveDisplayState("deferred", 0), "deferred");
  assert.equal(deriveDisplayState("open", 1, true), "ready");
  assert.equal(deriveDisplayState("open", 0, false), "blocked");
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

test("defaults to active unblocked leaves and separates attention and containers", () => {
  const graph = normalizeIssues(
    [
      { id: "agentscope-beads-001", title: "Active", status: "in_progress", priority: 0 },
      { id: "agentscope-beads-002", title: "Blocked", status: "in_progress", priority: 1 },
      { id: "agentscope-beads-003", title: "Stale", status: "in_progress", priority: 1 },
      { id: "agentscope-beads-004", title: "Container", status: "in_progress", issue_type: "epic" },
    ],
    { blockedIds: ["agentscope-beads-002"], staleIds: ["agentscope-beads-003"] },
  );
  assert.deepEqual(filterGraph(graph).nodes.map((node) => node.displayId), ["beads-001"]);
  assert.deepEqual(
    filterGraph(graph, { view: "attention" }).nodes.map((node) => node.displayId),
    ["beads-002", "beads-003"],
  );
  assert.deepEqual(filterGraph(graph, { view: "containers" }).nodes.map((node) => node.displayId), ["beads-004"]);
  assert.deepEqual(filterGraph(graph, { query: "beads-003" }).nodes.map((node) => node.displayId), ["beads-003"]);
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
  assert.equal(
    dashboardMessage({ loadError: "Unable to read Beads.", warnings: ["ignored"], nodeCount: 0 }),
    "Unable to read Beads.",
  );
  assert.match(dashboardMessage({ warnings: ["ignored"], nodeCount: 0 }), /1 malformed/);
  assert.match(dashboardMessage({ nodeCount: 600, truncatedCount: 25 }), /25 additional/);
  assert.match(dashboardMessage({ nodeCount: 600, truncatedCount: 25, focused: true }), /focused neighborhood/);
  assert.equal(dashboardMessage({ warnings: [], nodeCount: 0 }), "No issues match these filters.");
});

test("caps visible graph work while retaining an explicit truncation count", () => {
  const graph = normalizeIssues(
    Array.from({ length: 700 }, (_, index) => ({ id: `issue-${index}`, title: `Issue ${index}` })),
  );
  const filtered = filterGraph(graph, { maxNodes: 600, view: "all" });
  assert.equal(filtered.nodes.length, 600);
  assert.equal(filtered.truncatedCount, 100);
});

test("keeps a focused high-degree neighborhood coherent and layout height bounded", () => {
  const dependents = Array.from({ length: 700 }, (_, index) => ({
    id: `dependent-${index}`,
    title: `Dependent ${index}`,
    dependencies: [{ issue_id: `dependent-${index}`, depends_on_id: "root", type: "blocks" }],
  }));
  const graph = normalizeIssues([...dependents, { id: "root", title: "Root" }]);
  const filtered = filterGraph(graph, {
    focusId: "root",
    focusDepth: 1,
    relationshipTypes: ["blocks"],
    maxNodes: 600,
  });
  assert.equal(filtered.nodes[0].id, "root");
  assert.equal(filtered.nodes.length, 600);
  assert.equal(filtered.edges.length, 599);
  assert.ok(layoutGraph(filtered).height <= 90 + 40 * 74);
});

test("restores keyboard focus to the same issue and interaction surface", () => {
  const activeElement = { dataset: { id: "issue-a" }, closest: (selector) => (selector === "#issue-list" ? {} : null) };
  const target = captureIssueFocus(activeElement, "issue-a");
  assert.deepEqual(target, { issueId: "issue-a", surface: "list" });
  let focused = false;
  const replacement = { dataset: { id: "issue-a" }, focus: () => (focused = true) };
  const roots = {
    graph: { querySelectorAll: () => [] },
    issueList: { querySelectorAll: () => [{ dataset: { id: "other" } }, replacement] },
  };
  assert.equal(restoreIssueFocus(roots, target), true);
  assert.equal(focused, true);
  assert.equal(captureIssueFocus(activeElement, "other"), null);
});

test("reads only through the supported read-only bd list command", async () => {
  assert.deepEqual(BD_LIST_ARGUMENTS, ["list", "--all", "--flat", "--limit", "0", "--json", "--readonly"]);
  const calls = [];
  const graph = await loadGraph(async (...arguments_) => {
    calls.push(arguments_);
    const command = arguments_[1];
    if (command === BD_LIST_ARGUMENTS) return { stdout: JSON.stringify(fixtures) };
    if (command === BD_READY_ARGUMENTS) return { stdout: JSON.stringify([fixtures[1]]) };
    if (command === BD_BLOCKED_ARGUMENTS) return { stdout: JSON.stringify([fixtures[2]]) };
    return { stdout: JSON.stringify([]) };
  });
  assert.equal(calls[0][0], "bd");
  assert.deepEqual(calls.map((entry) => entry[1]), [
    BD_LIST_ARGUMENTS,
    BD_READY_ARGUMENTS,
    BD_BLOCKED_ARGUMENTS,
    BD_STALE_ARGUMENTS,
  ]);
  assert.equal(graph.nodes.length, 3);
});

test("rejects malformed bd output and unsafe port arguments", async () => {
  await assert.rejects(() => loadGraph(async () => ({ stdout: "not-json" })), /malformed JSON/);
  assert.equal(parsePort([]), 4173);
  assert.equal(parsePort(["--port", "8000"]), 8000);
  assert.throws(() => parsePort(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parsePort(["--host", "0.0.0.0"]), /Usage/);
});

test("bounds issue, relationship, and projection work", () => {
  assert.throws(
    () => normalizeIssues(Array.from({ length: 5_001 }, (_, index) => ({ id: `i${index}`, title: "Issue" }))),
    /Issue count/,
  );
  assert.throws(
    () =>
      normalizeIssues([
        { id: "root", title: "Root" },
        {
          id: "many",
          title: "Many",
          dependencies: Array.from({ length: 257 }, () => ({
            issue_id: "many",
            depends_on_id: "root",
            type: "blocks",
          })),
        },
      ]),
    /Per-issue relationship/,
  );
  const bounded = normalizeIssues([{ id: "ok", title: "Good", issue_type: "x".repeat(1_000) }]);
  assert.equal(bounded.nodes[0].issueType.length, 80);
  assert.equal("assignee" in bounded.nodes[0], false);
});

async function withServer(graphLoader, callback) {
  const server = createDashboardServer({ graphLoader });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function requestStatus(port, { host = `127.0.0.1:${port}`, path = "/api/issues" } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path, headers: { host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function rawMalformedTargetStatus(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1])));
    socket.on("error", reject);
  });
}

test("enforces loopback HTTP authority and coalesces concurrent graph loads", async () => {
  let calls = 0;
  let release;
  let markEntered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  await withServer(async () => {
    calls += 1;
    markEntered();
    await pending;
    return normalizeIssues(fixtures);
  }, async (port) => {
    assert.equal(await requestStatus(port, { host: "rebind.example" }), 421);
    assert.equal(
      await requestStatus(port, { host: `127.0.0.1:${port}`, path: "http://rebind.example/api/issues" }),
      421,
    );
    const requests = Array.from({ length: 12 }, () => fetch(`http://127.0.0.1:${port}/api/issues`));
    let results;
    let entryTimeout;
    try {
      await Promise.race([
        entered,
        new Promise((_, reject) => {
          entryTimeout = setTimeout(() => reject(new Error("loader entry was not observed")), 2_000);
        }),
      ]);
      assert.equal(calls, 1);
    } finally {
      clearTimeout(entryTimeout);
      release();
      results = await Promise.allSettled(requests);
    }
    assert.ok(results.every((result) => result.status === "fulfilled" && result.value.status === 200));
  });
});

test("returns fixed errors for malformed targets and loader diagnostics", async () => {
  await withServer(async () => {
    throw new Error("synthetic-private-diagnostic-canary");
  }, async (port) => {
    const diagnostic = await fetch(`http://127.0.0.1:${port}/api/issues`);
    assert.deepEqual(await diagnostic.json(), { error: "beads-read-failed" });
    assert.equal(await requestStatus(port, { host: "127.0.0.1:1" }), 421);
    assert.equal(await rawMalformedTargetStatus(port), 400);
    const healthy = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(healthy.status, 200);
  });
});
