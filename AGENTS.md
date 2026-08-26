# Software Factory methodology

This repository uses the Software Factory methodology. Requirements are the external, user-facing source of truth: use Product Overview Documents for product-wide framing and Feature Requirements Documents (FRDs) with `Overview`, `Terminology`, stable `REQ-*` IDs, user stories, and testable `AC-*` acceptance criteria. Blueprints are internal, lightweight ADR-focused records with a Capability Summary and decision-first ADRs. Use the project-local `software-factory` skill before creating or revising either record type.

Agentscope Software Factory records are repository-local files only. Never call or write a Software Factory MCP or external Software Factory document store for this project; any external record is non-authoritative. Keep delivery sequencing, ownership, dependencies, and blockers in Beads rather than requirements or Blueprints.

Use the project-local `review-agentscope` skill for independent code, pull-request, architecture, trust-boundary, evidence, and release reviews. Approved Blueprint decisions are binding on implementation reviews. A compelling architectural exception must be approved and merged through an earlier standalone Blueprint-only PR; never revise architecture inside an implementation PR merely to justify divergence.
