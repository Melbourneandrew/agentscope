# Beads dependency dashboard

This small, read-only dashboard visualizes the repository's current Beads dependency graph without adding a product package or workspace target.

From the repository root:

```bash
node .beads/dashboard/server.mjs
```

Open <http://127.0.0.1:4173>. To choose another local port:

```bash
node .beads/dashboard/server.mjs --port 4180
```

The server binds only to `127.0.0.1` and rejects other HTTP authorities/origins. Each refresh executes supported machine-readable `bd list`, `bd ready`, `bd blocked`, and one-day `bd stale --status in_progress` queries directly with `--json --readonly`, no shell, and no access to Dolt files. Concurrent refreshes share one bounded read. It returns a bounded projection of issue metadata; descriptions, notes, assignees, and other large or potentially sensitive fields are not sent to the browser.

The default view is **Active leaves**: recently updated, unblocked `in_progress` work that has no child tasks. **Needs attention** makes blocked or one-day-stale `in_progress` records conspicuous. Epics and any record with child tasks are visibly dashed **Containers**, not parallel implementation. Search bypasses the selected view so any issue remains easy to find. Arrows point from prerequisite toward dependent work; parent links are hierarchy, not blockers. Priority/view controls, optional hierarchy/context links, a 600-node ceiling, and two-hop focus keep the graph navigable.

The dashboard removes the redundant `agentscope-` project prefix when displaying and searching IDs. A stored `agentscope-release-007` is shown as `release-007`; canonical storage and historical dependencies remain unchanged.

Run focused tests:

```bash
node --test .beads/dashboard/graph.test.mjs
```
