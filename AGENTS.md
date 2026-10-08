# Software Factory methodology

This repository uses the Software Factory methodology. Requirements are the external, user-facing source of truth: use Product Overview Documents for product-wide framing and Feature Requirements Documents (FRDs) with `Overview`, `Terminology`, stable `REQ-*` IDs, user stories, and testable `AC-*` acceptance criteria. Blueprints are internal, lightweight ADR-focused records with a Capability Summary and decision-first ADRs. Use the project-local `software-factory` skill before creating or revising either record type.

Agentscope Software Factory records are repository-local files only. Never call or write a Software Factory MCP or external Software Factory document store for this project; any external record is non-authoritative. Keep delivery sequencing, ownership, dependencies, and blockers in Beads rather than requirements or Blueprints.

Use the project-local `review-agentscope` skill for independent code, pull-request, architecture, trust-boundary, evidence, and release reviews. Approved Blueprint decisions are binding on implementation reviews. A compelling architectural exception must be approved and merged through an earlier standalone Blueprint-only PR; never revise architecture inside an implementation PR merely to justify divergence.

## Precedent-first engineering

Ground implementation, testing, operations, and release design principally in comparable working projects: CodexBar, Crabbox, OpenClaw, and other packages solving the same problem. Read the relevant upstream implementation, not just its name or README. Record the source revision, applicable pattern, and Agentscope-specific differences. Prefer established tools and the smallest adequate adaptation; do not copy an unrelated project's full infrastructure.

Follow the repository-local [Engineering Precedents Blueprint](apps/docs/content/docs/blueprints/foundations/engineering-precedents.mdx). A bespoke subsystem or extra acceptance gate must identify the concrete requirement or observed failure it addresses, explain why existing patterns are insufficient, and earn its operational cost. Reviewers must challenge unnecessary infrastructure rather than invent new certification requirements. Architecture changes still require an earlier standalone Blueprint PR; this guidance is not permission to bypass existing requirements or release checks.
