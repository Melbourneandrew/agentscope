import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import * as langfuseRoot from "./index.js";
import {
  LANGFUSE_COMPATIBILITY_MANIFEST,
  langfuseDestinationPackageId,
  langfuseReporterPackageId,
  langfuseRetrieverPackageId,
} from "./index.js";
import {
  LANGFUSE_FILTER_CONFORMANCE_FIXTURES,
  LANGFUSE_SANITIZED_HTTP_FIXTURES,
  type LangfuseHttpFixture,
  type LangfuseJson,
} from "./testing.js";

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
  const fixtureByRequest = new Map(
    fixtures.map((fixture) => [
      requestKey(
        fixture.request.method,
        fixture.request.path,
        fixture.request.query,
        fixture.request.body,
      ),
      fixture,
    ]),
  );
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
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const fixture = fixtureByRequest.get(
        requestKey(
          request.method ?? "GET",
          url.pathname,
          Object.fromEntries(url.searchParams),
          raw ? (JSON.parse(raw) as LangfuseJson) : null,
        ),
      );
      if (!fixture) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "fixture.request.invalid" }));
        return;
      }
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

const requestKey = (
  method: string,
  path: string,
  query: Readonly<Record<string, string>>,
  body: unknown,
): string =>
  JSON.stringify({
    method,
    path,
    query: Object.fromEntries(
      Object.entries(query).sort(([a], [b]) => a.localeCompare(b)),
    ),
    body,
  });

const filterHttpFixtures: readonly LangfuseHttpFixture[] =
  LANGFUSE_FILTER_CONFORMANCE_FIXTURES.map((fixture) => ({
    fixtureId: fixture.fixtureId,
    profileId: fixture.profileId,
    request: fixture.request,
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        data: fixture.expectedTraceIds.map((returnedTraceId) => ({
          traceId: returnedTraceId,
        })),
        meta:
          fixture.profile === "v2"
            ? { cursor: null }
            : {
                page: 1,
                limit: 50,
                totalItems: fixture.expectedTraceIds.length,
                totalPages: 1,
              },
      },
    },
  }));

type OtlpAttribute = Readonly<{
  key: string;
  value: Readonly<{
    stringValue?: string;
    arrayValue?: Readonly<{
      values: readonly Readonly<{ stringValue: string }>[];
    }>;
  }>;
}>;

const projectOtlpRoot = (fixture: LangfuseHttpFixture) => {
  const body = fixture.request.body as {
    resourceSpans: readonly {
      scopeSpans: readonly {
        spans: readonly { attributes: readonly OtlpAttribute[] }[];
      }[];
    }[];
  };
  const attributes = body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
  if (!attributes) throw new Error("OTLP fixture lacks a root span");
  const metadata: Record<string, string> = {};
  let sessionId: string | undefined;
  let tags: readonly string[] | undefined;
  for (const attribute of attributes) {
    if (attribute.key.startsWith("langfuse.observation.metadata.")) {
      const value = attribute.value.stringValue;
      if (value === undefined)
        throw new Error("Metadata overlay is not a string");
      metadata[attribute.key.slice("langfuse.observation.metadata.".length)] =
        JSON.parse(value) as string;
    }
    if (attribute.key === "session.id") sessionId = attribute.value.stringValue;
    if (attribute.key === "langfuse.trace.tags")
      tags = attribute.value.arrayValue?.values.map(
        ({ stringValue }) => stringValue,
      );
  }
  return { metadata, sessionId, tags };
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
      "sha256:914b378357945f7a4d54e3f5ba91623023e60380db18f88f1b6e3bcaeda61c79",
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
    });
    expectDeeplyFrozen(LANGFUSE_COMPATIBILITY_MANIFEST);
    expectDeeplyFrozen(LANGFUSE_SANITIZED_HTTP_FIXTURES);
  });
});

describe("Langfuse compatibility profiles", () => {
  it("keeps package identities and compatibility profiles exact", () => {
    expect(langfuseRoot).not.toHaveProperty("LANGFUSE_SANITIZED_HTTP_FIXTURES");
    expect(langfuseRoot).not.toHaveProperty(
      "LANGFUSE_FILTER_CONFORMANCE_FIXTURES",
    );
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
});

describe("Langfuse portable-filter contract", () => {
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
    expect(cases).toHaveLength(48);
    for (const profileId of [
      "langfuse-cloud-v4",
      "langfuse-self-hosted-v4",
      "langfuse-self-hosted-v3-events-3.225.3",
    ]) {
      const profileCases = cases.filter(
        (entry) => entry.profileId === profileId,
      );
      expect(
        profileCases
          .filter(({ disposition }) => disposition === "match")
          .map(({ filter }) => filter),
      ).toEqual(expectedFilters);
      for (const filter of expectedFilters) {
        const pair = profileCases.filter((entry) => entry.filter === filter);
        expect(pair.map(({ disposition }) => disposition)).toEqual([
          "match",
          "miss",
        ]);
        expect(pair[0]?.request).not.toEqual(pair[1]?.request);
        expect(pair[0]?.expectedTraceIds).toEqual([
          "0123456789abcdef0123456789abcdef",
        ]);
        expect(pair[1]?.expectedTraceIds).toEqual([]);
      }
      for (const entry of profileCases) {
        expect(JSON.parse(entry.request.query.filter ?? "[]")).toContainEqual({
          type: "stringObject",
          column: "metadata",
          key: "agentscope_root",
          operator: "=",
          value: "true",
        });
        if (entry.profile === "v1-events")
          expect(entry.request.query.useEventsTable).toBe("true");
      }
    }
    expect(cases).toEqual(LANGFUSE_FILTER_CONFORMANCE_FIXTURES);
    expect(LANGFUSE_COMPATIBILITY_MANIFEST.filterFixtureDigests).toEqual(
      LANGFUSE_FILTER_CONFORMANCE_FIXTURES.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        sha256: digest(fixture),
      })),
    );
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
      maximumMetadataEntries: 72,
      maximumProjectionBytes: 16_384,
      maximumWireOverlayAttributes: 146,
      countGrammar: "^(?:0|[1-9]|[12][0-9]|3[0-2])$",
      indexGrammar: "^(?:0[0-9]|[12][0-9]|3[01])$",
      valueGrammar: "nonempty-nfc-utf8-without-control-characters",
      indexedValues: "exactly-count-contiguous-zero-based-two-digit-indices",
      reservedOwnership: "agentscope-exact-keys-and-index-prefixes",
      collisions: "reject-before-transport",
      truncation: "forbidden",
      malformedResponse:
        "missing-extra-duplicate-noncanonical-or-over-limit-mirror",
      wire: {
        observationMetadataPrefix: "langfuse.observation.metadata.",
        traceMetadataPrefix: "langfuse.trace.metadata.",
        sessionAttribute: "session.id",
        traceTagsAttribute: "langfuse.trace.tags",
      },
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
    expect(new RegExp(projection.countGrammar, "u").test("32")).toBe(true);
    expect(new RegExp(projection.countGrammar, "u").test("33")).toBe(false);
    expect(new RegExp(projection.indexGrammar, "u").test("31")).toBe(true);
    expect(new RegExp(projection.indexGrammar, "u").test("32")).toBe(false);
  });

  it("derives the pinned retrieval projection from documented OTLP overlays", () => {
    const otlpFixture = LANGFUSE_SANITIZED_HTTP_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "otlp-v4-json-root-v1",
    );
    const v2Fixture = LANGFUSE_SANITIZED_HTTP_FIXTURES.find(
      ({ fixtureId }) => fixtureId === "observations-v2-root-search-v1",
    );
    if (!otlpFixture || !v2Fixture) throw new Error("Required fixture missing");
    const expected = (
      v2Fixture.response.body as {
        data: readonly {
          metadata: Readonly<Record<string, string>>;
          sessionId: string;
          tags: readonly string[];
        }[];
      }
    ).data[0];
    expect(projectOtlpRoot(otlpFixture)).toEqual({
      metadata: expected?.metadata,
      sessionId: expected?.sessionId,
      tags: expected?.tags,
    });
  });
});

describe("Langfuse compatibility fixture replay", () => {
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

  it("replays exact match/miss queries and rejects nonconforming requests", async () => {
    const fixtureServer = await startFixtureServer(filterHttpFixtures);
    try {
      for (const fixture of filterHttpFixtures) {
        const query = new URLSearchParams(fixture.request.query).toString();
        const result = await fetch(
          `${fixtureServer.origin}${fixture.request.path}?${query}`,
          { headers: fixture.request.headers },
        );
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual(fixture.response.body);
      }
      const invalid = await fetch(
        `${fixtureServer.origin}/api/public/observations?useEventsTable=false`,
        { headers: { authorization: "[credential-slot]" } },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ code: "fixture.request.invalid" });
      for (const selector of [undefined, "false", "1"] as const) {
        const fixture = LANGFUSE_FILTER_CONFORMANCE_FIXTURES.find(
          ({ profile }) => profile === "v1-events",
        );
        if (!fixture) throw new Error("v1 fixture missing");
        const query = { ...fixture.request.query };
        if (selector === undefined) delete query.useEventsTable;
        else query.useEventsTable = selector;
        const result = await fetch(
          `${fixtureServer.origin}${fixture.request.path}?${new URLSearchParams(query)}`,
          { headers: fixture.request.headers },
        );
        expect(result.status).toBe(400);
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
        maximumResponseBytes: 1_048_576,
        maximumResponseRows: 1000,
        consistency: "best-effort",
      });
    }
    expect(selfHostedV3?.reporter.headers).toEqual({});
    expect(selfHostedV3?.retriever).toMatchObject({
      maximumResponseBytes: 1_048_576,
      maximumResponseRows: 100,
    });
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
