# Contributing to Agentscope

The initial repository bootstrap landed directly on `main`. All subsequent
changes use a pull request.

1. Create a focused branch from `main` (for example,
   `codex/andrew/add-codex-fixtures`).
2. Run focused checks in your isolated worktree. Mutation-heavy integration uses
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
`bd ready` and claim the issue before editing. When a dependency unblocks a
stalled task, resume it from the exact merged SHA rather than leaving it idle.

The inner hermetic scenario runner is shared across CI and Crabbox execution.
Crabbox is contributor infrastructure for development and burst testing, while
GitHub CI remains release authority. Neither is an end-user installation path.
