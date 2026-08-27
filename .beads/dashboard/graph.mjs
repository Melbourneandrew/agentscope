const KNOWN_STATUSES = new Set(["open", "in_progress", "blocked", "deferred", "closed"]);
const RELATIONSHIP_TYPES = new Set(["blocks", "parent-child", "discovered-from", "related", "supersedes"]);

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function integer(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

export function normalizeIssues(input) {
  if (!Array.isArray(input)) {
    return { nodes: [], edges: [], warnings: ["Beads returned a non-array JSON document."] };
  }

  const warnings = [];
  const nodes = [];
  const seen = new Set();

  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("Ignored a non-object issue record.");
      continue;
    }
    const id = text(raw.id).trim().slice(0, 160);
    const title = text(raw.title).trim().slice(0, 500);
    if (!id || !title || seen.has(id)) {
      warnings.push(`Ignored an issue with ${seen.has(id) ? `duplicate id ${id}` : "missing id/title"}.`);
      continue;
    }
    seen.add(id);
    const status = KNOWN_STATUSES.has(raw.status) ? raw.status : "open";
    nodes.push({
      id,
      title,
      status,
      priority: Math.min(4, Math.max(0, integer(raw.priority, 2))),
      issueType: text(raw.issue_type, "task"),
      assignee: text(raw.assignee).slice(0, 160),
      labels: Array.isArray(raw.labels)
        ? raw.labels
            .filter((label) => typeof label === "string")
            .slice(0, 40)
            .map((label) => label.slice(0, 160))
        : [],
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [];
  const edgeKeys = new Set();
  for (const node of nodes) {
    for (const rawDependency of node.dependencies) {
      if (!rawDependency || typeof rawDependency !== "object") {
        warnings.push(`Ignored a malformed relationship on ${node.id}.`);
        continue;
      }
      const dependent = text(rawDependency.issue_id, node.id).trim();
      const prerequisite = text(rawDependency.depends_on_id).trim();
      const type = text(rawDependency.type, "blocks");
      if (dependent !== node.id || !prerequisite || !nodeIds.has(prerequisite)) {
        warnings.push(`Ignored an unresolved relationship on ${node.id}.`);
        continue;
      }
      if (!RELATIONSHIP_TYPES.has(type)) {
        warnings.push(`Ignored unsupported relationship type ${type} on ${node.id}.`);
        continue;
      }
      const key = `${prerequisite}\u0000${dependent}\u0000${type}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        // Execution flows from prerequisite to dependent.
        edges.push({ source: prerequisite, target: dependent, type });
      }
    }
    delete node.dependencies;
  }

  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const blockingEdges = edges.filter((edge) => edge.type === "blocks");
  for (const node of nodes) {
    const activeBlockers = blockingEdges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .filter((id) => statusById.get(id) !== "closed");
    node.activeBlockers = activeBlockers;
    node.displayState = deriveDisplayState(node.status, activeBlockers.length);
  }

  return { nodes, edges, warnings };
}

export function deriveDisplayState(status, activeBlockerCount) {
  if (status === "closed") return "closed";
  if (status === "in_progress") return "in-progress";
  if (status === "deferred") return "deferred";
  if (status === "blocked" || activeBlockerCount > 0) return "blocked";
  return "ready";
}

export function filterGraph(graph, options = {}) {
  const query = text(options.query).trim().toLocaleLowerCase();
  const statuses = new Set(options.statuses ?? ["ready", "blocked", "in-progress", "deferred"]);
  const priorities = new Set((options.priorities ?? [0, 1, 2, 3, 4]).map(Number));
  const relationshipTypes = new Set(options.relationshipTypes ?? ["blocks"]);
  const focusId = text(options.focusId);
  const focusDepth = Math.max(0, Math.min(6, integer(options.focusDepth, 2)));

  let allowedByFocus = null;
  if (focusId && graph.nodes.some((node) => node.id === focusId)) {
    allowedByFocus = new Set([focusId]);
    let frontier = new Set([focusId]);
    for (let depth = 0; depth < focusDepth; depth += 1) {
      const next = new Set();
      for (const edge of graph.edges) {
        if (!relationshipTypes.has(edge.type)) continue;
        if (frontier.has(edge.source)) next.add(edge.target);
        if (frontier.has(edge.target)) next.add(edge.source);
      }
      for (const id of next) allowedByFocus.add(id);
      frontier = next;
    }
  }

  const nodes = graph.nodes.filter((node) => {
    const matchesQuery = !query || `${node.id} ${node.title} ${node.labels.join(" ")}`.toLocaleLowerCase().includes(query);
    return (
      matchesQuery &&
      statuses.has(node.displayState) &&
      priorities.has(node.priority) &&
      (!allowedByFocus || allowedByFocus.has(node.id))
    );
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => relationshipTypes.has(edge.type) && ids.has(edge.source) && ids.has(edge.target),
  );
  return { nodes, edges, warnings: graph.warnings };
}

export function layoutGraph(graph) {
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
  for (const [lane, nodes] of lanes) {
    nodes.forEach((node, row) => positions.set(node.id, { x: 40 + lane * 292, y: 44 + row * 74, lane, row }));
  }
  const maxRows = Math.max(1, ...[...lanes.values()].map((nodes) => nodes.length));
  const maxLane = Math.max(0, ...lanes.keys());
  return { positions, width: 320 + maxLane * 292, height: 90 + maxRows * 74, cycleLayer };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
