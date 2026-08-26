# Blueprint Writing Guide

Write one lightweight, ADR-focused Blueprint per capability or integration area. Lead each ADR with the decision, include only context necessary to apply it, and capture consequences when trade-offs matter. Do not mirror the requirements hierarchy or create a parallel technical inventory.

Use Blueprints only for durable internal architecture that implementations must preserve. Do not encode release milestones, alpha or version admission subsets, implementation or merge order, rollout stages, ownership, dependencies, blockers, or project sequencing as ADRs; record those in Beads. A delivery plan cannot authorize implementation to diverge from an approved Blueprint, and a Blueprint cannot waive external product truth owned by requirements.
