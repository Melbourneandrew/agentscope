import { dashboardMessage, escapeHtml, filterGraph, layoutGraph } from "./graph.mjs";
import { captureIssueFocus, restoreIssueFocus } from "./focus.mjs";

/* global document, window */

const elements = {
  clearFocus: document.querySelector("#clear-focus"),
  count: document.querySelector("#count"),
  detail: document.querySelector("#detail"),
  filters: document.querySelector("#filters"),
  graph: document.querySelector("#graph"),
  graphScroll: document.querySelector("#graph-scroll"),
  hierarchy: document.querySelector("#hierarchy"),
  issueList: document.querySelector("#issue-list"),
  message: document.querySelector("#message"),
  priority: document.querySelector("#priority"),
  query: document.querySelector("#query"),
  refresh: document.querySelector("#refresh"),
  related: document.querySelector("#related"),
  view: document.querySelector("#view"),
};

let fullGraph = { nodes: [], edges: [], warnings: [] };
let focusId = "";
let loadError = "";

function stateOptions() {
  const statuses = ["ready", "blocked", "active", "blocked-active", "stale-active", "deferred", "closed"];
  const relationshipTypes = ["blocks"];
  if (elements.hierarchy.checked) relationshipTypes.push("parent-child");
  if (elements.related.checked) relationshipTypes.push("discovered-from", "related", "supersedes");
  return {
    query: elements.query.value,
    statuses,
    priorities: elements.priority.value === "all" ? [0, 1, 2, 3, 4] : [Number(elements.priority.value)],
    relationshipTypes,
    focusId,
    focusDepth: 2,
    view: elements.view.value,
  };
}

function shorten(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function edgePath(source, target) {
  const sourceX = source.x + 244;
  const sourceY = source.y + 25;
  const targetX = target.x;
  const targetY = target.y + 25;
  if (targetX >= sourceX) {
    const middle = sourceX + (targetX - sourceX) / 2;
    return `M ${sourceX} ${sourceY} C ${middle} ${sourceY}, ${middle} ${targetY}, ${targetX} ${targetY}`;
  }
  const bend = Math.max(sourceY, targetY) + 31;
  return `M ${sourceX} ${sourceY} C ${sourceX + 28} ${bend}, ${targetX - 28} ${bend}, ${targetX} ${targetY}`;
}

function showDetail(node) {
  if (!node) {
    elements.detail.innerHTML = "<h2>Selection</h2><p>Select a node to focus its dependency neighborhood.</p>";
    return;
  }
  const prerequisites = fullGraph.edges.filter((edge) => edge.type === "blocks" && edge.target === node.id);
  const dependents = fullGraph.edges.filter((edge) => edge.type === "blocks" && edge.source === node.id);
  const displayForId = (id) => fullGraph.nodes.find((item) => item.id === id)?.displayId ?? id;
  const list = (items, field) =>
    items.length
      ? `<ul>${items.map((item) => `<li><code>${escapeHtml(displayForId(item[field]))}</code></li>`).join("")}</ul>`
      : "<p>None</p>";
  elements.detail.innerHTML = `
    <h2>${escapeHtml(node.title)}</h2>
    <p><code>${escapeHtml(node.displayId)}</code><br>P${node.priority} · ${escapeHtml(node.displayState)} · ${node.isContainer ? "container" : "executable leaf"} · ${escapeHtml(node.issueType)}</p>
    <h2>Active blockers</h2>${list(node.activeBlockers.map((source) => ({ source })), "source")}
    <h2>Prerequisites</h2>${list(prerequisites, "source")}
    <h2>Dependents</h2>${list(dependents, "target")}
    ${node.labels.length ? `<h2>Labels</h2><p>${node.labels.map(escapeHtml).join(" · ")}</p>` : ""}
  `;
}

function selectNode(id) {
  const restoreTarget = captureIssueFocus(document.activeElement, id);
  focusId = id;
  if (focusId) elements.query.value = "";
  elements.clearFocus.disabled = !focusId;
  showDetail(fullGraph.nodes.find((node) => node.id === focusId));
  render(restoreTarget);
}

function render(restoreTarget = null) {
  const graph = filterGraph(fullGraph, stateOptions());
  const layout = layoutGraph(graph);
  elements.count.textContent = `${graph.nodes.length} of ${fullGraph.nodes.length} issues · ${graph.edges.length} visible links`;
  elements.message.textContent = dashboardMessage({
    loadError,
    warnings: fullGraph.warnings,
    nodeCount: graph.nodes.length,
    truncatedCount: graph.truncatedCount,
    focused: Boolean(focusId),
  });
  elements.graph.setAttribute("width", String(Math.max(layout.width, elements.graphScroll.clientWidth - 2)));
  elements.graph.setAttribute("height", String(layout.height));
  elements.graph.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  const displayById = new Map(fullGraph.nodes.map((node) => [node.id, node.displayId]));

  const edges = graph.edges
    .map((edge) => {
      const source = layout.positions.get(edge.source);
      const target = layout.positions.get(edge.target);
      if (!source || !target) return "";
      return `<path class="edge ${escapeHtml(edge.type)}" d="${edgePath(source, target)}" marker-end="url(#arrow)"><title>${escapeHtml(displayById.get(edge.source) ?? edge.source)} → ${escapeHtml(displayById.get(edge.target) ?? edge.target)} (${escapeHtml(edge.type)})</title></path>`;
    })
    .join("");
  const nodes = graph.nodes
    .map((node) => {
      const position = layout.positions.get(node.id);
      return `<a class="node ${escapeHtml(node.displayState)} ${node.isContainer ? "container-node" : "leaf-node"} ${node.id === focusId ? "selected" : ""}" href="#${encodeURIComponent(node.id)}" data-id="${escapeHtml(node.id)}" transform="translate(${position.x} ${position.y})">
        <rect class="body" width="244" height="50" rx="7" />
        <rect class="priority" width="6" height="50" rx="3" />
        <text class="node-id" x="15" y="16">${escapeHtml(shorten(node.displayId, 31))}</text>
        <text class="node-title" x="15" y="32">${escapeHtml(shorten(node.title, 34))}</text>
        <text class="node-meta" x="226" y="16" text-anchor="end">P${node.priority}${node.isContainer ? " · group" : ""}</text>
        <title>${escapeHtml(`${node.displayId}: ${node.title}. P${node.priority}, ${node.displayState}, ${node.isContainer ? "container" : "executable leaf"}. Select to focus two dependency hops.`)}</title>
      </a>`;
    })
    .join("");
  elements.graph.innerHTML = `<title id="graph-title">Beads dependency graph</title><desc id="graph-description">Arrows point from prerequisite work toward dependent work.</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" /></marker></defs>${edges}${nodes}`;
  elements.issueList.innerHTML = graph.nodes
    .map(
      (node) =>
        `<li><button type="button" data-id="${escapeHtml(node.id)}">${escapeHtml(node.displayId)} — ${escapeHtml(node.title)} (P${node.priority}, ${escapeHtml(node.displayState)}${node.isContainer ? ", container" : ""})</button></li>`,
    )
    .join("");
  for (const nodeElement of elements.graph.querySelectorAll(".node")) {
    nodeElement.addEventListener("click", (event) => {
      event.preventDefault();
      selectNode(nodeElement.dataset.id);
    });
  }
  for (const nodeElement of elements.issueList.querySelectorAll("button")) {
    nodeElement.addEventListener("click", () => selectNode(nodeElement.dataset.id));
  }
  restoreIssueFocus(elements, restoreTarget);
}

async function refresh() {
  elements.refresh.disabled = true;
  loadError = "";
  elements.message.textContent = "Reading current Beads data…";
  try {
    const response = await fetch("/api/issues", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to read Beads");
    fullGraph = payload;
    if (focusId && !fullGraph.nodes.some((node) => node.id === focusId)) focusId = "";
    render();
  } catch {
    loadError = "Unable to read Beads. Check the local terminal and refresh.";
    fullGraph = { nodes: [], edges: [], warnings: [] };
    render();
  } finally {
    elements.refresh.disabled = false;
  }
}

for (const element of [elements.query, elements.priority, elements.view, elements.hierarchy, elements.related]) {
  element.addEventListener("input", render);
}
elements.clearFocus.addEventListener("click", () => {
  focusId = "";
  elements.clearFocus.disabled = true;
  showDetail(null);
  render();
});
elements.refresh.addEventListener("click", refresh);
elements.filters.addEventListener("submit", (event) => {
  event.preventDefault();
  render();
});
window.addEventListener("resize", render);

await refresh();
