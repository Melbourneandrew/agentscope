# Integration suite

The default lane compiles the versioned capability manifest, packs and verifies the candidate CLI before Docker starts, records exact artifact and lockfile digests, and mounts only the prepared bundle plus a read-only checkout. The scenario container performs no package installation or registry download. `test:integration:live` remains separate and runs only with protected external credentials.
