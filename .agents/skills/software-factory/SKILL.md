---
name: software-factory
description: Use when creating or revising Software Factory requirements, blueprints, or delivery records.
---

# Software Factory

Software Factory keeps product intent, technical intent, and delivery work connected.

## Agentscope storage boundary

Create and revise every Agentscope Software Factory record locally as a file in
this repository. Never call or write through a remote Software Factory MCP or
external Software Factory document store for this project. An external record
is non-authoritative even if it uses the expected schema or identifiers.

Keep delivery sequencing, milestone composition, task ownership, dependencies,
and blockers in Beads. Do not encode release sequencing or temporary milestone
scope as product requirements or Blueprints.

## Records

- **Product Overview Documents** describe product-wide why and what: business problem, current state, personas, product description, success metrics, and technical requirements.
- **Feature Requirements Documents (FRDs)** describe localized user value. Use `## Overview`, `## Terminology`, and `## Requirements`. Each requirement has a stable `REQ-[PREFIX]-NNN` ID, one user story in the form `As a [role], I want to [action], so that I can [outcome].`, and atomic `AC-[PREFIX]-NNN.N` criteria in the form `When [condition], the system shall [behavior].` Use `shall` for mandatory, `should` for recommended, and `may` for optional behavior.
- **Blueprints** are lightweight internal ADRs. Every Blueprint uses `## Capability Summary` and `## Architecture Decision Records`; each ADR starts with a direct `**Decision:**`, then concise `**Context:**` and optional `**Consequences:**`.

Requirements state what must be true for users. Blueprints record durable technical decisions; do not use them for exhaustive APIs, schemas, component inventories, or implementation plans.

## Authority boundaries

- **Requirements own external product truth.** Put user-visible behavior, supported capabilities, compatibility promises, and the rules that bound release support claims in Product Overview Documents or FRDs.
- **Blueprints own durable internal architecture.** Record the technical decisions that implementations must preserve to satisfy the requirements, independent of a particular delivery sequence.
- **Beads owns delivery coordination.** Put release milestones, alpha or version admission subsets, implementation and merge order, rollout stages, ownership, dependencies, blockers, and project sequencing there.

A Bead may sequence a narrower milestone, but it cannot replace or weaken a requirement or justify divergence from a Blueprint. If user-facing product truth or durable architecture must change, revise the owning record through its separate approval process before implementation.

For example, “a release may advertise only harness versions and execution modes backed by its release support manifest” is requirement-owned product truth. The exact harnesses scheduled for a milestone, their owners, merge order, and blockers are Beads-only delivery state.

Before revising a requirement or Blueprint, read the relevant guide in this directory.

For a thorough Blueprint review, read [guides/reviewing-blueprints.md](guides/reviewing-blueprints.md) and follow its bounded iterative review process.
