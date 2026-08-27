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

The server binds only to `127.0.0.1` and rejects other HTTP authorities/origins. Each refresh executes the supported machine-readable commands `bd list --all --flat --limit 0 --json --readonly` and `bd ready --limit 0 --json --readonly` directly, with no shell and no access to Dolt files. Concurrent refreshes share one bounded read. It returns a bounded projection of issue metadata; descriptions, notes, assignees, and other large or potentially sensitive fields are not sent to the browser.

Arrows point from a prerequisite toward the work that depends on it. Stored status plus open `blocks` dependencies derive the visible ready/blocked state. Search, priority/status controls, optional hierarchy/context links, and two-hop node focus keep the live graph navigable. Generated files and cache state are not required.

Run focused tests:

```bash
node --test .beads/dashboard/graph.test.mjs
```
