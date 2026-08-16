# Contributing to AgentScope

The initial repository bootstrap landed directly on `main`. All subsequent
changes use a pull request.

1. Create a focused branch from `main` (for example,
   `codex/andrew/add-codex-fixtures`).
2. Run the relevant local checks, including `pnpm test:integration` when an
   adapter, reporter, or hook changes.
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
