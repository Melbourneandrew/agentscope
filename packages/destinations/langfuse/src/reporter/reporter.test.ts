import { Buffer } from "node:buffer";

import {
  isDestinationDescriptor,
  parseDestinationSettings,
} from "@agentscope/destinations-core";
import {
  createReporterContractSuite,
  invokeDestinationReporterForTesting,
  prepareDestinationReporterForTesting,
} from "@agentscope/destinations-core/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";
import { describe, expect, it } from "vitest";

import { LANGFUSE_COMPATIBILITY_MANIFEST } from "../compatibility.js";
import {
  createLangfuseDestinationTestAdapter,
  createLangfuseReporterTestHarness,
} from "../testing.js";
import {
  langfuseDestinationDescriptor,
  langfuseReporterPackageId,
} from "./index.js";

const encoder = new TextEncoder();
const jsonBody = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const settings = (
  profileId:
    | "langfuse-cloud-v4"
    | "langfuse-self-hosted-v4"
    | "langfuse-self-hosted-v3-events-3.225.3" = "langfuse-cloud-v4",
) => ({
  endpoint: "http://127.0.0.1:4318",
  allowInsecureLoopback: true,
  profileId,
  compatibilityManifestId: LANGFUSE_COMPATIBILITY_MANIFEST.manifestId,
  encoding: "application/json" as const,
});

const credentials = () => ({
  "public-key": "pk-fixture",
  "secret-key": "sk-fixture",
});

const expectedAuthorization = (): string =>
  `Basic ${Buffer.from("pk-fixture:sk-fixture", "utf8").toString("base64")}`;

const prepare = (
  response: Readonly<{
    status: number;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
  }>,
  requests: Record<string, unknown>[] = [],
  profileId?: Parameters<typeof settings>[0],
) =>
  prepareDestinationReporterForTesting({
    descriptor: langfuseDestinationDescriptor,
    settings: settings(profileId),
    credentials: credentials(),
    executor: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: response.status,
        headers: response.headers ?? { "content-type": "application/json" },
        body: response.body ?? jsonBody({}),
      });
    },
  });

const rootAttributes = (body: unknown) => {
  const request = body as {
    resourceSpans: {
      scopeSpans: {
        spans: { parentSpanId?: string; attributes: unknown[] }[];
      }[];
    }[];
  };
  return request.resourceSpans[0]!.scopeSpans[0]!.spans.find(
    (span) => span.parentSpanId === undefined,
  )!.attributes as {
    key: string;
    value: {
      stringValue?: string;
      arrayValue?: { values: { stringValue: string }[] };
    };
  }[];
};

describe("Langfuse destination descriptor", () => {
  it("declares one strict remote Reporter configuration without secret settings", () => {
    expect(isDestinationDescriptor(langfuseDestinationDescriptor)).toBe(true);
    expect(langfuseReporterPackageId).toBe(
      "@agentscope/destination-langfuse/reporter",
    );
    expect(langfuseDestinationDescriptor).toMatchObject({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-langfuse",
      commandName: "langfuse",
      settingsVersion: 1,
      deliveryIdentitySupport: "duplicates-possible",
      retrievalSupport: "search-and-get",
      transport: { kind: "remote" },
    });
    expect(langfuseDestinationDescriptor.credentialSlots).toEqual([
      { id: "public-key", required: true },
      { id: "secret-key", required: true },
    ]);
    expect(langfuseDestinationDescriptor.settingKeys).not.toContain(
      "secret-key",
    );
    expect(() =>
      parseDestinationSettings(langfuseDestinationDescriptor, {
        ...settings(),
        unknown: true,
      }),
    ).toThrowError("destination.descriptor.invalid");
  });

  it("rejects non-HTTPS remote endpoints and mismatched manifest identities", () => {
    expect(() =>
      prepareDestinationReporterForTesting({
        descriptor: langfuseDestinationDescriptor,
        settings: {
          ...settings(),
          endpoint: "http://example.com",
        },
        credentials: credentials(),
        executor: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: jsonBody({}),
          }),
      }),
    ).toThrowError("destination.descriptor.invalid");
    expect(() =>
      prepareDestinationReporterForTesting({
        descriptor: langfuseDestinationDescriptor,
        settings: {
          ...settings(),
          compatibilityManifestId: "sha256:stale",
        },
        credentials: credentials(),
        executor: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: jsonBody({}),
          }),
      }),
    ).toThrowError("destination.descriptor.invalid");
  });

  it("rejects an authorization value beyond the family header ceiling during setup", () => {
    expect(() =>
      prepareDestinationReporterForTesting({
        descriptor: langfuseDestinationDescriptor,
        settings: settings(),
        credentials: {
          "public-key": "p".repeat(8_192),
          "secret-key": "s".repeat(8_192),
        },
        executor: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: jsonBody({}),
          }),
      }),
    ).toThrowError("destination.descriptor.invalid");
  });
});

describe("Langfuse shared Reporter contract", () => {
  const traces = [
    createSanitizedRedactedCanonicalTraceFixture({ sequence: 30 }),
  ] as const;
  for (const contractCase of createReporterContractSuite({
    adapter: createLangfuseDestinationTestAdapter(),
    traces,
  }))
    it(contractCase.name, contractCase.run);
});

describe("Langfuse testing subpath", () => {
  const response = () =>
    Promise.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: jsonBody({}),
    });

  it("invokes the actual default Reporter with a default fixture", async () => {
    const harness = createLangfuseReporterTestHarness({ executor: response });
    await expect(harness.report()).resolves.toEqual({ outcome: "accepted" });
  });

  it("accepts explicit profile, fixture, signal, and timeout inputs", async () => {
    const harness = createLangfuseReporterTestHarness({
      executor: response,
      profileId: "langfuse-self-hosted-v3-events-3.225.3",
    });
    await expect(
      harness.report({
        trace: { sequence: 31, tags: ["testing"] },
        signal: new AbortController().signal,
        timeoutMilliseconds: 1_000,
      }),
    ).resolves.toEqual({ outcome: "accepted" });
  });
});

// eslint-disable-next-line max-lines-per-function -- the suite keeps the exact transport, projection, resource-isolation, and receipt evidence together.
describe("Langfuse OTLP Reporter", () => {
  it("sends one exact projected OTLP batch while preserving canonical fields", async () => {
    const requests: Record<string, unknown>[] = [];
    const reporter = prepare({ status: 200 }, requests);
    const first = createSanitizedRedactedCanonicalTraceFixture({
      sequence: 1,
      sessionId: "session-fixture",
      tags: ["safe-tag"],
      modelName: "model-fixture",
    });
    const second = createSanitizedRedactedCanonicalTraceFixture({
      sequence: 2,
    });
    const identities = [first.delivery.identity, second.delivery.identity];
    await expect(
      invokeDestinationReporterForTesting(reporter, {
        traces: [first, second],
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect([first.delivery.identity, second.delivery.identity]).toEqual(
      identities,
    );
    expect(requests).toHaveLength(1);
    const request = requests[0] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Uint8Array;
    };
    expect(request.url).toBe("http://127.0.0.1:4318/api/public/otel/v1/traces");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      authorization: expectedAuthorization(),
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
    const body = JSON.parse(new TextDecoder().decode(request.body)) as {
      resourceSpans: unknown[];
    };
    expect(body.resourceSpans).toHaveLength(4);
    const capsuleResources = (
      body as {
        resourceSpans: {
          resource?: { attributes?: { key: string }[] };
          scopeSpans: { scope?: { name?: string } }[];
        }[];
      }
    ).resourceSpans.filter((resource) =>
      resource.scopeSpans.some(
        ({ scope }) =>
          scope?.name === "@agentscope/destination-langfuse/capsule",
      ),
    );
    expect(capsuleResources).toHaveLength(2);
    expect(
      capsuleResources.map((resource) =>
        resource.resource?.attributes?.map(({ key }) => key),
      ),
    ).toEqual([
      ["agentscope.protocol.manifest_id", "service.name"],
      ["agentscope.protocol.manifest_id", "service.name"],
    ]);
    const attributes = rootAttributes(body);
    const capsuleAttributes = (
      body as {
        resourceSpans: {
          scopeSpans: {
            spans: { name: string; attributes?: typeof attributes }[];
          }[];
        }[];
      }
    ).resourceSpans
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans)
      .find(
        (span) => span.name === "agentscope.capsule.header.v1",
      )!.attributes!;
    expect(attributes).toContainEqual({
      key: "agentscope.harness.name",
      value: { stringValue: "fixture-harness" },
    });
    expect(capsuleAttributes).toContainEqual({
      key: "langfuse.observation.metadata.agentscope_root",
      value: { stringValue: "true" },
    });
    expect(capsuleAttributes).toContainEqual({
      key: "langfuse.trace.metadata.agentscope_span_count",
      value: { stringValue: "3" },
    });
    expect(capsuleAttributes).toContainEqual({
      key: "session.id",
      value: { stringValue: "session-fixture" },
    });
    expect(capsuleAttributes).toContainEqual({
      key: "langfuse.trace.tags",
      value: {
        arrayValue: {
          values: [
            { stringValue: "agentscope:model:model-fixture" },
            { stringValue: "safe-tag" },
          ],
        },
      },
    });
    expect(attributes.some(({ key }) => key === "agentscope_root")).toBe(false);
  });

  it("uses the profile-owned v3 header shape", async () => {
    const requests: Record<string, unknown>[] = [];
    const reporter = prepare(
      { status: 200 },
      requests,
      "langfuse-self-hosted-v3-events-3.225.3",
    );
    await invokeDestinationReporterForTesting(reporter, {
      traces: [createSanitizedRedactedCanonicalTraceFixture()],
    });
    expect(
      (requests[0] as { headers: Record<string, string> }).headers,
    ).not.toHaveProperty("x-langfuse-ingestion-version");
  });
});

describe("Langfuse OTLP Reporter outcomes", () => {
  it.each([
    [400, {}, "rejected"],
    [307, {}, "rejected"],
    [429, {}, "unavailable"],
    [500, {}, "outcome-unknown"],
    [202, {}, "outcome-unknown"],
    [
      200,
      { partialSuccess: { rejectedSpans: "not-an-integer" } },
      "outcome-unknown",
    ],
    [
      200,
      { partialSuccess: { rejectedSpans: "1", errorMessage: "partial" } },
      "outcome-unknown",
    ],
    [
      200,
      { partialSuccess: { rejectedSpans: "0", errorMessage: "warning" } },
      "outcome-unknown",
    ],
  ] as const)(
    "maps HTTP %s and its acknowledgement to %s",
    async (status, body, outcome) => {
      const reporter = prepare({ status, body: jsonBody(body) });
      await expect(
        invokeDestinationReporterForTesting(reporter, {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
        }),
      ).resolves.toEqual({ outcome });
    },
  );

  it("contains transport rejection, hangs, and pre-abort conservatively", async () => {
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const rejected = prepareDestinationReporterForTesting({
      descriptor: langfuseDestinationDescriptor,
      settings: settings(),
      credentials: credentials(),
      executor: () => Promise.reject(new Error("CANARY_SECRET")),
    });
    await expect(
      invokeDestinationReporterForTesting(rejected, { traces: [trace] }),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
    let resolveTransportStart: (() => void) | undefined;
    const transportStarted = new Promise<void>((resolve) => {
      resolveTransportStart = resolve;
    });
    const hanging = prepareDestinationReporterForTesting({
      descriptor: langfuseDestinationDescriptor,
      settings: settings(),
      credentials: credentials(),
      executor: () => {
        resolveTransportStart?.();
        return new Promise(() => undefined);
      },
    });
    const hangingController = new AbortController();
    const hangingResult = invokeDestinationReporterForTesting(hanging, {
      traces: [trace],
      signal: hangingController.signal,
      timeoutMilliseconds: 1_000,
    });
    await transportStarted;
    hangingController.abort();
    await expect(hangingResult).resolves.toEqual({
      outcome: "outcome-unknown",
    });
    const requests: Record<string, unknown>[] = [];
    const preAborted = prepare({ status: 200 }, requests);
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeDestinationReporterForTesting(preAborted, {
        traces: [trace],
        signal: controller.signal,
      }),
    ).resolves.toEqual({ outcome: "deadline-exceeded" });
    expect(requests).toHaveLength(0);
  });
});

describe("Langfuse OTLP response containment", () => {
  it("maps malformed acknowledgement bytes to outcome-unknown", async () => {
    const reporter = prepare({
      status: 200,
      body: encoder.encode("{"),
    });
    await expect(
      invokeDestinationReporterForTesting(reporter, {
        traces: [createSanitizedRedactedCanonicalTraceFixture()],
      }),
    ).resolves.toEqual({ outcome: "outcome-unknown" });
  });

  it.each([
    "application/json",
    "Application/JSON; Charset=UTF-8",
    'application/json; charset="utf-8"',
  ])(
    "accepts the governed JSON response media type %s",
    async (contentType) => {
      const reporter = prepare({
        status: 200,
        headers: { "content-type": contentType },
      });
      await expect(
        invokeDestinationReporterForTesting(reporter, {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
        }),
      ).resolves.toEqual({ outcome: "accepted" });
    },
  );

  it.each([
    ["missing", {}],
    ["wrong", { "content-type": "text/plain" }],
    ["wrong charset", { "content-type": "application/json; charset=utf-16" }],
    [
      "ambiguous",
      { "content-type": "application/json; charset=utf-8; charset=utf-8" },
    ],
  ] as const)(
    "does not accept a 200 response with %s OTLP media type",
    async (_description, headers) => {
      const reporter = prepare({ status: 200, headers });
      await expect(
        invokeDestinationReporterForTesting(reporter, {
          traces: [createSanitizedRedactedCanonicalTraceFixture()],
        }),
      ).resolves.toEqual({ outcome: "outcome-unknown" });
    },
  );
});

describe("Langfuse OTLP Reporter identity and projection", () => {
  it.each([
    { tags: ["agentscope:model:user-owned"] },
    { tags: ["e\u0301"] },
    { tags: ["é", "e\u0301"] },
    { tags: ["line\nbreak"] },
    { modelName: "x".repeat(200) },
  ])(
    "rejects an unrepresentable projection before transport",
    async (options) => {
      const requests: Record<string, unknown>[] = [];
      const reporter = prepare({ status: 200 }, requests);
      const trace = createSanitizedRedactedCanonicalTraceFixture(options);
      await expect(
        invokeDestinationReporterForTesting(reporter, { traces: [trace] }),
      ).resolves.toEqual({ outcome: "rejected" });
      expect(requests).toHaveLength(0);
    },
  );

  it("keeps the W3C identity stable across a repeated attempt", async () => {
    const requests: Record<string, unknown>[] = [];
    const reporter = prepare({ status: 200 }, requests);
    const trace = createSanitizedRedactedCanonicalTraceFixture({ sequence: 4 });
    const deliveryIdentity = trace.delivery.identity;
    for (let attempt = 0; attempt < 2; attempt += 1)
      await invokeDestinationReporterForTesting(reporter, { traces: [trace] });
    const wireIdentities = requests.map((request) => {
      const body = JSON.parse(
        new TextDecoder().decode((request as { body: Uint8Array }).body),
      ) as {
        resourceSpans: {
          scopeSpans: { spans: { traceId: string; spanId: string }[] }[];
        }[];
      };
      return body.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
      }));
    });
    expect(wireIdentities[0]!.slice(0, 3)).toEqual(
      wireIdentities[1]!.slice(0, 3),
    );
    expect((requests[0] as { body: Uint8Array }).body).not.toEqual(
      (requests[1] as { body: Uint8Array }).body,
    );
    expect(trace.delivery.identity).toBe(deliveryIdentity);
  });
});
