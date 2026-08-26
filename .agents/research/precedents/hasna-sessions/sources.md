# Sources

Reviewed 2026-08-25.

## Pinned identities

- npm package: [`@hasna/sessions@0.12.21`](https://www.npmjs.com/package/@hasna/sessions), Apache-2.0, registry integrity `sha512-iFirfWknpqiqjQVG7hY53aySV4ye6briK3CNX6Rj3bWSo9sstObQQj8PopKAd6KSFdw5Cs2Js+TdMDy9US9OdQ==`.
- Source reviewed: [`hasna/apps` commit `88abe16ef3fc54291f41feb915a1f032d4315ec0`](https://github.com/hasna/apps/tree/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions).
- The npm metadata names `hasna/sessions`, while the current reviewed implementation is in the `hasna/apps` monorepo. Conclusions bind to the monorepo commit above, not an assumed equivalence between repositories.

## Primary source links

- [Package manifest](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/package.json)
- [Parser contract](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/ingest/types.ts)
- [Ingestion coordinator and lock](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/ingest/index.ts)
- [Codex source locator](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/ingest/codex.ts)
- [Bounded OpenAI rollout parser](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/ingest/openai-rollout.ts)
- [Session persistence and preferred-snapshot selection](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/db/sessions.ts)
- [Content shrink policy](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/content-import-safety.ts)
- [Watcher and polling safety net](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/watch.ts)
- [Embedding implementation](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/src/lib/embeddings.ts)
- [Codex adapter tests](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/apps/sessions/test/codex-adapter.test.ts)
- [CI workflow](https://github.com/hasna/apps/blob/88abe16ef3fc54291f41feb915a1f032d4315ec0/.github/workflows/ci.yml)
