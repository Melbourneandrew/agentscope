# Contributing to Agentscope

The initial repository bootstrap landed directly on `main`. All subsequent
changes use a pull request.

1. Create a focused branch from `main` (for example,
   `codex/andrew/add-codex-fixtures`).
2. Run the relevant deterministic local checks. Mutation-heavy integration uses
   `pnpm test:integration` only on an allocated disposable Crabbox guest or in
   GitHub-hosted CI, never on a workstation or shared Docker daemon.
3. Open a pull request. `Validate` and `Hermetic integration test` must pass;
   resolve all conversations.
4. Use **Squash and merge**. GitHub deletes the branch after merge.

`main` is protected with linear history, required pull requests, required
checks, and conversation resolution. No approval count is imposed while this
is a single-maintainer project, but the PR remains the reviewable integration
point.

Every durable implementation task must have a Beads issue. Start with
`bd ready`, claim the issue before editing, and sync Beads with `bd sync` at
handoff.
