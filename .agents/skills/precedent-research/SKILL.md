---
name: precedent-research
description: Research and maintain Agentscope precedent records only when the user explicitly says "precedent research," invokes $precedent-research, or explicitly asks to add or update a precedent record. Do not use for ordinary comparisons or implementation research.
---

# Precedent Research

Store agent-only records under `.agents/research/precedents/<precedent>/`. Keep the root index comparative and each precedent's `README.md` analytical; put pinned revisions, retrieval dates, licenses, and links in `sources.md`.

- Bind observations to exact versions or commits and a research date.
- Label observed facts, inferences, and Agentscope recommendations distinctly.
- Compare capture authority, lifecycle integration, data model, persistence, delivery, retrieval, privacy, failure/concurrency, installation ownership, and testing.
- Link and summarize third-party material; do not copy source or documentation into the repository.
- Mark stale or superseded research instead of silently rewriting its historical scope.
- Treat all precedent records as non-authoritative. Requirements and approved Blueprints take precedence, and recommendations require the normal decision process before implementation.
- Do not edit Requirements or Blueprints as part of precedent research.
