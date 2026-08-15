# NPM release setup

The repository uses npm trusted publishing, not a long-lived `NPM_TOKEN`. The workflow publishes the public `@agentscope/core` package only from a pushed semantic tag such as `v0.1.0`; the CLI remains private until its executable implementation exists.

## One-time maintainer setup

1. Create or obtain the `@agentscope` npm organization/scope under the intended npm account. The current GitHub identity does not yet have authority for that scope.
2. Create `@agentscope/core` at npm (a one-time initial release can use the same release workflow after trusted publishing is configured).
3. In the package settings on npmjs.com, add a GitHub Actions trusted publisher with:
   - Organization or user: `Melbourneandrew`
   - Repository: `agentscope`
   - Workflow filename: `publish-npm.yml`
   - Allowed action: `npm publish`
4. Keep the GitHub repository public and retain the workflow's `id-token: write` permission. npm will generate provenance automatically for trusted publishes.
5. Once the CLI has a real compiled `dist/bin/agent-scope.js`, remove `private: true`, add it to the release command, and configure a second trusted publisher for `@agentscope/cli`.

To release, update package versions, commit them, create a signed `vX.Y.Z` tag, and push that tag. Normal merges to `main` validate but never publish.
