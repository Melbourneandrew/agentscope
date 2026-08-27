# Beads - AI-Native Issue Tracking

Welcome to Beads! This repository uses **Beads** for issue tracking - a modern, AI-native tool designed to live directly in your codebase alongside your code.

## What is Beads?

Beads is issue tracking that lives in your repo, making it perfect for AI coding agents and developers who want their issues close to their code. No web UI required - everything works through the CLI and integrates seamlessly with git.

**Learn more:** [github.com/steveyegge/beads](https://github.com/steveyegge/beads)

## Quick Start

### Essential Commands

```bash
# Create the next sequential issue in a workstream
node .beads/create.mjs auth "Add user authentication"

# View all issues
bd list

# View issue details
bd show <issue-id>

# Update issue status
bd update <issue-id> --claim
bd update <issue-id> --status done

# Sync with Dolt remote
bd dolt push
```

## Agentscope issue IDs

New work uses a short workstream plus a three-digit sequence. The database keeps its required project prefix, while people and the dashboard use the shorter reference:

- stored: `agentscope-release-007`
- conversational: `release-007`

Create the next collision-safe ID in a workstream from the repository root:

```bash
node .beads/create.mjs release "Rehearse alpha publication" --type task --priority 1
```

The helper reads existing IDs through supported read-only `bd` JSON, serializes compliant allocators with an ignored local lock in the canonical Beads workspace, rechecks candidate IDs, calls `bd create --id` directly without a shell, and prints the short ID. The lock records the allocator's PID and process-start identity; a later helper run can atomically retire a released lock or one whose exact owner is gone, including after abrupt termination. Ambiguous lock state fails closed instead of being deleted. `--parent release-003` and dependency values such as `--deps blocks:hermetic-012` are expanded to canonical IDs. The helper owns ID, title, database, directory, repository-routing, global-store, and execution-mode flags; always use it for sequential IDs because the current `bd create --id` does not reject an existing explicit ID. Do not use `bd rename-prefix` or mass-rename historical issues.

Suggested workstreams are short and durable: `crabbox`, `hermetic`, `release`, `codex`, `claude`, `sqlite`, and `beads`.

### Working with Issues

Issues in Beads are:
- **Git-native**: Stored in Dolt database with version control and branching
- **AI-friendly**: CLI-first design works perfectly with AI coding agents
- **Branch-aware**: Issues can follow your branch workflow
- **Sync-ready**: Uses Dolt remotes for backup and team sharing

## Why Beads?

✨ **AI-Native Design**
- Built specifically for AI-assisted development workflows
- CLI-first interface works seamlessly with AI coding agents
- No context switching to web UIs

🚀 **Developer Focused**
- Issues live in your repo, right next to your code
- Works offline, syncs when you push
- Fast, lightweight, and stays out of your way

🔧 **Git Integration**
- Dolt-native sync via bd dolt push / bd dolt pull
- Branch-aware issue tracking
- Dolt-native three-way merge resolution

## Get Started with Beads

Try Beads in your own projects:

```bash
# Install Beads
curl -sSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# Initialize in your repo
bd init

# Create your first issue
bd create "Try out Beads"
```

## Learn More

- **Documentation**: [github.com/steveyegge/beads/docs](https://github.com/steveyegge/beads/tree/main/docs)
- **Quick Start Guide**: Run `bd quickstart`
- **Examples**: [github.com/steveyegge/beads/examples](https://github.com/steveyegge/beads/tree/main/examples)

---

*Beads: Issue tracking that moves at the speed of thought* ⚡
