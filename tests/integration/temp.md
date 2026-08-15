# Integration suite

The CI default is hermetic: Docker Compose starts a fake collector and executes sanitized provider fixtures in temporary configuration roots. `test:integration:live` is intentionally separate and only runs with protected Langfuse credentials.
