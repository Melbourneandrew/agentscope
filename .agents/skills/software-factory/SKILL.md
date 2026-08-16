---
name: software-factory
description: Use when creating or revising Software Factory requirements, blueprints, or delivery records.
---

# Software Factory

Software Factory keeps product intent, technical intent, and delivery work connected.

## Records

- **Product Overview Documents** describe product-wide why and what: business problem, current state, personas, product description, success metrics, and technical requirements.
- **Feature Requirements Documents (FRDs)** describe localized user value. Use `## Overview`, `## Terminology`, and `## Requirements`. Each requirement has a stable `REQ-[PREFIX]-NNN` ID, one user story in the form `As a [role], I want to [action], so that I can [outcome].`, and atomic `AC-[PREFIX]-NNN.N` criteria in the form `When [condition], the system shall [behavior].` Use `shall` for mandatory, `should` for recommended, and `may` for optional behavior.
- **Blueprints** are lightweight internal ADRs. Every Blueprint uses `## Capability Summary` and `## Architecture Decision Records`; each ADR starts with a direct `**Decision:**`, then concise `**Context:**` and optional `**Consequences:**`.

Requirements state what must be true for users. Blueprints record durable technical decisions; do not use them for exhaustive APIs, schemas, component inventories, or implementation plans.

Before revising a requirement or Blueprint, read the relevant guide in this directory.
