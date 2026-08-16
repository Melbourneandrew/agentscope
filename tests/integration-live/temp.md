# Protected live integration suite

This workspace is the stable entry point for the real Langfuse smoke test.
It intentionally does not run in pull requests. The first reporter slice will
send a synthetic, redacted trace and query it back using the protected
`langfuse-live` GitHub Environment.

Required environment values are `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
and `LANGFUSE_BASE_URL`. Never place them in local config files tracked by Git.
