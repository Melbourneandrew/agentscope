import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  LANGFUSE_COMPATIBILITY_MANIFEST,
  LANGFUSE_SANITIZED_HTTP_FIXTURES,
  langfuseDestinationPackageId,
  langfuseReporterPackageId,
  langfuseRetrieverPackageId,
  type LangfuseHttpFixture,
} from "./index.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const expectDeeplyFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeeplyFrozen(nested);
};

type RecordedRequest = Readonly<{
  body: unknown;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}>;

const startFixtureServer = async (
  fixtures: readonly LangfuseHttpFixture[],
): Promise<
  Readonly<{ origin: string; requests: RecordedRequest[]; server: Server }>
> => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk as Uint8Array);
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        body: raw ? (JSON.parse(raw) as unknown) : null,
        headers: request.headers,
        method: request.method ?? "GET",
        path: request.url ?? "/",
      });
      const fixture = fixtures[index++];
      if (!fixture) throw new Error("Fixture server received an extra request");
      response.writeHead(fixture.response.status, fixture.response.headers);
      response.end(JSON.stringify(fixture.response.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not bind a TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
};

const stopServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );

describe("Langfuse compatibility contract", () => {
  it("pins one immutable provisional manifest to reviewed official sources", () => {
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.manifestId).toBe(
      "sha256:d8d845c901512659ea128e77837fc59e20eb5c7e1af81acf8a40d0ef01b17fda",
    );
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.status).toBe(
      "provisional-contract-only",
    );
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.liveValidationTask).toBe(
      "agentscope-vah.12.6",
    );
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.authority).toEqual({
      selection: "configuration-commit-only",
      configurationIdentityIncludes: ["profile-id", "manifest-id"],
      doctor: "observational-only",
      profileChange: "new-configuration-generation-invalidates-cursors",
      retrievalCapability:
        "withheld-unless-profile-and-complete-portable-filter-conformance",
      incompatiblePortableFilter: "retrieval-capability-withheld",
    });
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.sources).toMatchObject({
      langfuseOpenApi: {
        revision: "249b25734235d6b66fa36e57adb2c6cac0f40f98",
        sha256:
          "9ba51a22782a481ee2bf57513541a2bc3df1388e8d2c5c5a081f3a8e7e08366d",
      },
      langfuseV3Observations: {
        revision: "f6c77b70842bd84e3f22d820471345819cd9a1b4",
        tag: "v3.225.3",
      },
      langfuseJavascriptAttributes: {
        revision: "a7c9634286f5d6810dddf60bb94181c011a6f5b3",
      },
      langfusePythonAttributes: {
        revision: "3b1357c2206dae90d0a2bcdc65b1bcf768c29543",
      },
      officialDocumentation: {
        revision: "b235e0dee03a8c6abcfd631c9c1341d232cbfa02",
      },
    });
    expectDeeplyFrozen(LANGFUSE_COMPATIBILITY_MANIFEST);
    expectDeeplyFrozen(LANGFUSE_SANITIZED_HTTP_FIXTURES);
  });

  it("keeps package identities and compatibility profiles exact", () => {
    expect({
      destination: langfuseDestinationPackageId,
      reporter: langfuseReporterPackageId,
      retriever: langfuseRetrieverPackageId,
    }).toEqual({
      destination: "@agentscope/destination-langfuse",
      reporter: "@agentscope/destination-langfuse/reporter",
      retriever: "@agentscope/destination-langfuse/retriever",
    });
    expect(
      LANGFUSE_COMPATIBILITY_MANIFEST.profiles.map(
        ({ profileId }) => profileId,
      ),
    ).toEqual([
      "langfuse-cloud-v4",
      "langfuse-self-hosted-v4",
      "langfuse-self-hosted-v3-events-3.225.3",
    ]);
    expect(
      LANGFUSE_COMPATIBILITY_MANIFEST.profiles[2]?.retriever,
    ).toMatchObject({
      path: "/api/public/observations",
      mandatoryQuery: { useEventsTable: "true" },
      pagination: "page-offset",
      maximumLimit: 100,
    });
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.v1SelectorConformance).toEqual([
      { caseId: "present-true", value: "true", conforms: true },
      { caseId: "omitted", value: null, conforms: false },
      { caseId: "false", value: "false", conforms: false },
      { caseId: "mutated", value: "1", conforms: false },
    ]);
  });

  it("covers every portable predicate with provider-specific match and miss cases", () => {
    const expectedFilters = [
      "traceId",
      "from",
      "to",
      "harness",
      "branch",
      "model",
      "session",
      "tags",
    ];
    expect(
      Object.keys(LANGFUSE_COMPATIBILITY_MANIFEST.portableFilters),
    ).toEqual(expectedFilters);
    expect(
      "repository" in LANGFUSE_COMPATIBILITY_MANIFEST.portableFilters,
    ).toBe(false);

    const cases = LANGFUSE_COMPATIBILITY_MANIFEST.portableFilterConformance;
    expect(cases).toHaveLength(16);
    for (const profile of ["v2", "v1-events"] as const) {
      const profileCases = cases.filter((entry) => entry.profile === profile);
      expect(profileCases.map(({ filter }) => filter)).toEqual(expectedFilters);
      for (const entry of profileCases) {
        expect(entry.request.positive).not.toBe(entry.request.negative);
      }
    }
  });
});

describe("Langfuse compatibility fixtures", () => {
  it("closes the bounded root projection and indexed v1 response mirror", () => {
    const projection = LANGFUSE_COMPATIBILITY_MANIFEST.projection;
    expect(projection).toMatchObject({
      root: "agentscope_root",
      session: "agentscope_session",
      harness: "agentscope_harness",
      branch: "agentscope_branch",
      repository: "agentscope_repository",
      spanCount: "agentscope_span_count",
      modelCount: "agentscope_models_count",
      modelIndexPrefix: "agentscope_model_",
      tagCount: "agentscope_tags_count",
      tagIndexPrefix: "agentscope_tag_",
      modelTagPrefix: "agentscope:model:",
      maximumModels: 32,
      maximumTags: 32,
      maximumValueCharacters: 200,
    });
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.rootObservation).toEqual({
      selector: "metadata:agentscope_root:=:true",
      cardinality: "exactly-one-per-trace",
      missing: "malformed-response",
      duplicate: "malformed-response",
      summaryProjection: "root-observation-only",
    });
    const projectionNames = Object.values(projection).filter(
      (value) => typeof value === "string",
    );
    expect(new Set(projectionNames).size).toBe(projectionNames.length);
    const v1Fixture = LANGFUSE_SANITIZED_HTTP_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "observations-v1-events-root-search-v1",
    );
    expect(v1Fixture?.response.body).toMatchObject({
      data: [
        {
          metadata: {
            agentscope_models_count: "1",
            agentscope_model_00: "gpt-5",
            agentscope_tags_count: "1",
            agentscope_tag_00: "fixture",
          },
        },
      ],
    });
  });

  it("pins sanitized fixture digests without secret or local-path content", () => {
    expect(
      LANGFUSE_COMPATIBILITY_MANIFEST.fixtureDigests.map(
        (entry) => entry.fixtureId,
      ),
    ).toEqual(
      LANGFUSE_SANITIZED_HTTP_FIXTURES.map(({ fixtureId }) => fixtureId),
    );
    for (const fixture of LANGFUSE_SANITIZED_HTTP_FIXTURES) {
      expect(
        LANGFUSE_COMPATIBILITY_MANIFEST.fixtureDigests.find(
          ({ fixtureId }) => fixtureId === fixture.fixtureId,
        )?.sha256,
      ).toBe(digest(fixture));
    }
    const serialized = JSON.stringify(LANGFUSE_SANITIZED_HTTP_FIXTURES);
    expect(serialized).not.toMatch(
      /sk-[A-Za-z0-9]|Bearer |\/Users\/|\/home\//u,
    );
    expect(serialized).toContain("[credential-slot]");
  });

  it("replays every request and response through a hermetic MockServer", async () => {
    const fixtureServer = await startFixtureServer(
      LANGFUSE_SANITIZED_HTTP_FIXTURES,
    );
    try {
      for (const fixture of LANGFUSE_SANITIZED_HTTP_FIXTURES) {
        const query = new URLSearchParams(fixture.request.query).toString();
        const result = await fetch(
          `${fixtureServer.origin}${fixture.request.path}${query ? `?${query}` : ""}`,
          {
            method: fixture.request.method,
            headers: fixture.request.headers,
            ...(fixture.request.body === null
              ? {}
              : { body: JSON.stringify(fixture.request.body) }),
          },
        );
        expect(result.status).toBe(fixture.response.status);
        expect(await result.json()).toEqual(fixture.response.body);
      }

      expect(fixtureServer.requests).toHaveLength(
        LANGFUSE_SANITIZED_HTTP_FIXTURES.length,
      );
      for (const [index, request] of fixtureServer.requests.entries()) {
        const fixture = LANGFUSE_SANITIZED_HTTP_FIXTURES[index];
        const query = new URLSearchParams(fixture?.request.query).toString();
        expect(request).toMatchObject({
          body: fixture?.request.body,
          method: fixture?.request.method,
          path: `${fixture?.request.path}${query ? `?${query}` : ""}`,
        });
        for (const [name, value] of Object.entries(
          fixture?.request.headers ?? {},
        )) {
          expect(request.headers[name]).toBe(value);
        }
      }
    } finally {
      await stopServer(fixtureServer.server);
    }
  });
});

describe("Langfuse compatibility evidence", () => {
  it("closes auth, limits, rate-limit, and asynchronous cleanup behavior", () => {
    const [cloud, selfHostedV4, selfHostedV3] =
      LANGFUSE_COMPATIBILITY_MANIFEST.profiles;
    for (const profile of [cloud, selfHostedV4]) {
      expect(profile?.reporter).toMatchObject({
        authentication: "basic-public-key-secret-key",
        headers: { "x-langfuse-ingestion-version": "4" },
      });
      expect(profile?.retriever).toMatchObject({
        path: "/api/public/v2/observations",
        pagination: "cursor",
        defaultLimit: 50,
        maximumLimit: 1000,
        consistency: "best-effort",
      });
    }
    expect(selfHostedV3?.reporter.headers).toEqual({});
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.rateLimit).toEqual({
      status: 429,
      retryHeader: "retry-after",
      result: "rate-limited",
      providerBody: "discarded",
    });
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.cleanup).toEqual({
      method: "DELETE",
      pathTemplate: "/api/public/traces/{traceId}",
      completion: "asynchronous-poll-required",
      immediateCompletionClaimed: false,
    });
  });

  it("keeps empirical claims provisional and bound to the live validation task", () => {
    const empirical = LANGFUSE_COMPATIBILITY_MANIFEST.evidence.filter(
      ({ disposition }) => disposition === "live-validation-required",
    );
    expect(empirical.map(({ claimId }) => claimId)).toEqual([
      "otlp-to-observation-projection",
      "visibility-latency",
      "filter-round-trip",
      "asynchronous-cleanup-completion",
    ]);
    expect(
      empirical.every(
        (entry) => "task" in entry && entry.task === "agentscope-vah.12.6",
      ),
    ).toBe(true);
    expect(
      LANGFUSE_COMPATIBILITY_MANIFEST.evidence
        .filter(({ disposition }) => disposition === "provisional-official")
        .every((entry) => !("task" in entry)),
    ).toBe(true);
  });
});
