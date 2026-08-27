const KNOWN_STATUSES = new Set(["open", "in_progress", "blocked", "deferred", "closed"]);
const RELATIONSHIP_TYPES = new Set(["blocks", "parent-child", "discovered-from", "related", "supersedes"]);
const BLOCKING_RELATIONSHIP_TYPES = new Set(["blocks"]);
const MAX_ISSUES = 5_000;
const MAX_RELATIONSHIPS = 25_000;
const MAX_RELATIONSHIPS_PER_ISSUE = 256;
const MAX_PROJECTION_BYTES = 6 * 1024 * 1024;
const MAX_WARNINGS = 100;
const TEXT_ENCODER = new TextEncoder();

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function integer(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

export function displayIssueId(id) {
  return typeof id === "string" && id.startsWith("agentscope-") ? id.slice("agentscope-".length) : id;
}

export function normalizeIssues(input, { readyIds, blockedIds = [], staleIds = [] } = {}) {
  if (!Array.isArray(input)) {
    return { nodes: [], edges: [], warnings: ["Beads returned a non-array JSON document."] };
  }
  if (input.length > MAX_ISSUES) throw new RangeError("Issue count exceeds the dashboard ceiling");

  const warnings = [];
  const nodes = [];
  const seen = new Set();
  let projectionBytes = 0;
  const warn = (message) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  };

  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warn("Ignored a non-object issue record.");
      continue;
    }
    const id = text(raw.id).trim();
    const title = text(raw.title).trim().slice(0, 500);
    if (!id || id.length > 160 || !title || seen.has(id)) {
      warn(`Ignored an issue with ${seen.has(id) ? "a duplicate id" : "an invalid id/title"}.`);
      continue;
    }
    seen.add(id);
    const status = KNOWN_STATUSES.has(raw.status) ? raw.status : "open";
    nodes.push({
      id,
      title,
      status,
      priority: Math.min(4, Math.max(0, integer(raw.priority, 2))),
      issueType: text(raw.issue_type, "task").slice(0, 80),
      labels: Array.isArray(raw.labels)
        ? raw.labels
            .filter((label) => typeof label === "string")
            .slice(0, 40)
            .map((label) => label.slice(0, 160))
        : [],
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    });
    projectionBytes += TEXT_ENCODER.encode(id).byteLength + TEXT_ENCODER.encode(title).byteLength + 100;
    projectionBytes += nodes
      .at(-1)
      .labels.reduce((total, label) => total + TEXT_ENCODER.encode(label).byteLength, 0);
    if (projectionBytes > MAX_PROJECTION_BYTES) throw new RangeError("Dashboard projection exceeds the byte ceiling");
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [];
  const edgeKeys = new Set();
  for (const node of nodes) {
    if (node.dependencies.length > MAX_RELATIONSHIPS_PER_ISSUE) {
      throw new RangeError("Per-issue relationship count exceeds the dashboard ceiling");
    }
    for (const rawDependency of node.dependencies) {
      if (!rawDependency || typeof rawDependency !== "object") {
        warn(`Ignored a malformed relationship on ${node.id}.`);
        continue;
      }
      const dependent = text(rawDependency.issue_id, node.id).trim();
      const prerequisite = text(rawDependency.depends_on_id).trim();
      const type = text(rawDependency.type, "blocks");
      if (dependent !== node.id || !prerequisite || !nodeIds.has(prerequisite)) {
        warn(`Ignored an unresolved relationship on ${node.id}.`);
        continue;
      }
      if (!RELATIONSHIP_TYPES.has(type)) {
        warn(`Ignored an unsupported relationship type on ${node.id}.`);
        continue;
      }
      const key = `${prerequisite}\u0000${dependent}\u0000${type}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        // Execution flows from prerequisite to dependent.
        edges.push({ source: prerequisite, target: dependent, type });
        projectionBytes +=
          TEXT_ENCODER.encode(prerequisite).byteLength +
          TEXT_ENCODER.encode(dependent).byteLength +
          TEXT_ENCODER.encode(type).byteLength +
          40;
        if (projectionBytes > MAX_PROJECTION_BYTES) {
          throw new RangeError("Dashboard projection exceeds the byte ceiling");
        }
        if (edges.length > MAX_RELATIONSHIPS) throw new RangeError("Relationship count exceeds the dashboard ceiling");
      }
    }
    delete node.dependencies;
  }

  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const activeBlockersByTarget = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (BLOCKING_RELATIONSHIP_TYPES.has(edge.type) && statusById.get(edge.source) !== "closed") {
      activeBlockersByTarget.get(edge.target)?.push(edge.source);
    }
  }
  const canonicalReadyIds = readyIds === undefined ? null : new Set(readyIds);
  const canonicalBlockedIds = new Set(blockedIds);
  const canonicalStaleIds = new Set(staleIds);
  const containerIds = new Set(nodes.filter((node) => node.issueType === "epic").map((node) => node.id));
  const childIds = new Set();
  for (const edge of edges) if (edge.type === "parent-child") containerIds.add(edge.source);
  for (const edge of edges) if (edge.type === "parent-child") childIds.add(edge.target);
  for (const node of nodes) {
    const canonicallyReady = canonicalReadyIds ? canonicalReadyIds.has(node.id) : undefined;
    const localActiveBlockers = activeBlockersByTarget.get(node.id) ?? [];
    const blockedOnlyByHierarchy = childIds.has(node.id) && localActiveBlockers.length === 0;
    const canonicallyBlocked = canonicalBlockedIds.has(node.id) && !blockedOnlyByHierarchy;
    const effectiveCanonicalReadiness = blockedOnlyByHierarchy ? undefined : canonicallyReady;
    const stale = node.status === "in_progress" && canonicalStaleIds.has(node.id);
    const activeBlockers = canonicallyReady ? [] : localActiveBlockers;
    node.activeBlockers = activeBlockers;
    node.isContainer = containerIds.has(node.id);
    node.isLeaf = !node.isContainer;
    node.isStale = stale;
    node.displayId = displayIssueId(node.id);
    node.displayState = deriveDisplayState(
      node.status,
      activeBlockers.length,
      effectiveCanonicalReadiness,
      canonicallyBlocked,
      stale,
    );
    node.workClass = deriveWorkClass(node);
  }

  return { nodes, edges, warnings };
}

export function deriveDisplayState(status, activeBlockerCount, canonicallyReady, canonicallyBlocked = false, stale = false) {
  if (status === "closed") return "closed";
  if (status === "in_progress" && canonicallyBlocked) return "blocked-active";
  if (status === "in_progress" && stale) return "stale-active";
  if (status === "in_progress") return "active";
  if (status === "deferred") return "deferred";
  if (status === "blocked") return "blocked";
  if (canonicallyReady === true) return "ready";
  if (activeBlockerCount > 0) return "blocked";
  if (canonicallyReady === false) return "blocked";
  return "ready";
}

export function deriveWorkClass(node) {
  if (node.status === "closed") return "closed";
  if (node.displayState === "blocked-active" || node.displayState === "stale-active") return "attention";
  if (node.isContainer) return "container";
  if (node.displayState === "active") return "active-leaf";
  if (node.displayState === "ready") return "ready-leaf";
  return "other-leaf";
}

export function dashboardMessage({ loadError = "", warnings = [], nodeCount = 0, truncatedCount = 0, focused = false }) {
  if (loadError) return loadError;
  const messages = [];
  if (warnings.length) messages.push(`${warnings.length} malformed or unresolved record(s) were safely ignored.`);
  if (truncatedCount) {
    messages.push(
      focused
        ? `${truncatedCount} additional issue(s) in this focused neighborhood are hidden. Narrow search or priority.`
        : `${truncatedCount} additional issue(s) are hidden. Narrow the filters or focus a node.`,
    );
  }
  if (!nodeCount && messages.length === 0) messages.push("No issues match these filters.");
  return messages.join(" ");
}

export function filterGraph(graph, options = {}) {
  const query = text(options.query).trim().toLocaleLowerCase();
  const statuses = new Set(
    options.statuses ?? ["ready", "blocked", "active", "blocked-active", "stale-active", "deferred"],
  );
  const priorities = new Set((options.priorities ?? [0, 1, 2, 3, 4]).map(Number));
  const relationshipTypes = new Set(options.relationshipTypes ?? ["blocks"]);
  const focusId = text(options.focusId);
  const focusDepth = Math.max(0, Math.min(6, integer(options.focusDepth, 2)));
  const maxNodes = Math.max(1, Math.min(1_000, integer(options.maxNodes, 600)));
  const view = text(options.view, "active");

  let allowedByFocus = null;
  let focusDistances = null;
  if (focusId && graph.nodes.some((node) => node.id === focusId)) {
    allowedByFocus = new Set([focusId]);
    focusDistances = new Map([[focusId, 0]]);
    let frontier = new Set([focusId]);
    for (let depth = 0; depth < focusDepth; depth += 1) {
      const next = new Set();
      for (const edge of graph.edges) {
        if (!relationshipTypes.has(edge.type)) continue;
        if (frontier.has(edge.source)) next.add(edge.target);
        if (frontier.has(edge.target)) next.add(edge.source);
      }
      for (const id of next) {
        allowedByFocus.add(id);
        if (!focusDistances.has(id)) focusDistances.set(id, depth + 1);
      }
      frontier = next;
    }
  }

  const matchingNodes = graph.nodes.filter((node) => {
    const matchesQuery =
      !query || `${node.id} ${node.displayId} ${node.title} ${node.labels.join(" ")}`.toLocaleLowerCase().includes(query);
    const matchesView =
      Boolean(focusId) ||
      Boolean(query) ||
      view === "all" ||
      (view === "all-open" && node.status !== "closed") ||
      (view === "active" && node.workClass === "active-leaf") ||
      (view === "attention" && node.workClass === "attention") ||
      (view === "ready" && node.workClass === "ready-leaf") ||
      (view === "containers" && node.isContainer);
    return (
      matchesQuery &&
      matchesView &&
      statuses.has(node.displayState) &&
      priorities.has(node.priority) &&
      (!allowedByFocus || allowedByFocus.has(node.id))
    );
  });
  if (focusDistances) {
    matchingNodes.sort(
      (a, b) =>
        (focusDistances.get(a.id) ?? Number.POSITIVE_INFINITY) -
          (focusDistances.get(b.id) ?? Number.POSITIVE_INFINITY) ||
        a.priority - b.priority ||
        a.id.localeCompare(b.id),
    );
  }
  if (!focusDistances) {
    const workOrder = new Map([
      ["active-leaf", 0],
      ["attention", 1],
      ["ready-leaf", 2],
      ["other-leaf", 3],
      ["container", 4],
      ["closed", 5],
    ]);
    matchingNodes.sort(
      (a, b) =>
        (workOrder.get(a.workClass) ?? 9) - (workOrder.get(b.workClass) ?? 9) ||
        a.priority - b.priority ||
        a.displayId.localeCompare(b.displayId),
    );
  }
  const nodes = matchingNodes.slice(0, maxNodes);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => relationshipTypes.has(edge.type) && ids.has(edge.source) && ids.has(edge.target),
  );
  return { nodes, edges, warnings: graph.warnings, truncatedCount: matchingNodes.length - nodes.length };
}

export function layoutGraph(graph) {
  const maxRowsPerColumn = 40;
  const ids = new Set(graph.nodes.map((node) => node.id));
  const dependencyEdges = graph.edges.filter(
    (edge) => edge.type === "blocks" && ids.has(edge.source) && ids.has(edge.target),
  );
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of dependencyEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const layer = new Map();
  const queue = graph.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  for (const id of queue) layer.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    for (const target of outgoing.get(id) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, (layer.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }

  // Cycles remain visible in a final lane instead of disappearing.
  const cycleLayer = Math.max(0, ...layer.values()) + 1;
  for (const node of graph.nodes) if (!layer.has(node.id)) layer.set(node.id, cycleLayer);

  const lanes = new Map();
  for (const node of graph.nodes) {
    const lane = layer.get(node.id) ?? 0;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(node);
  }
  for (const nodes of lanes.values()) {
    nodes.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  const positions = new Map();
  const physicalLaneStart = new Map();
  let nextPhysicalLane = 0;
  for (const lane of [...lanes.keys()].sort((a, b) => a - b)) {
    physicalLaneStart.set(lane, nextPhysicalLane);
    nextPhysicalLane += Math.max(1, Math.ceil(lanes.get(lane).length / maxRowsPerColumn));
  }
  for (const [lane, nodes] of lanes) {
    nodes.forEach((node, index) => {
      const physicalLane = physicalLaneStart.get(lane) + Math.floor(index / maxRowsPerColumn);
      const row = index % maxRowsPerColumn;
      positions.set(node.id, { x: 40 + physicalLane * 292, y: 44 + row * 74, lane, row });
    });
  }
  const maxRows = Math.max(1, ...[...lanes.values()].map((nodes) => Math.min(nodes.length, maxRowsPerColumn)));
  return { positions, width: 320 + Math.max(0, nextPhysicalLane - 1) * 292, height: 90 + maxRows * 74, cycleLayer };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
