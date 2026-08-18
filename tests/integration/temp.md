# Integration suite

The default lane compiles the versioned capability manifest, packs and verifies the candidate CLI, and prepares exact digest-pinned base images before any scenario starts. Each selection then runs in a fresh read-only container on its own Docker-internal network with empty tmpfs homes, worktree, and ledger. The built image contains only the selected manifest and verified prepared bundle; no checkout or host home is mounted, and public provider/registry probes must fail. `test:integration:live` remains separate and runs only with protected external credentials.
