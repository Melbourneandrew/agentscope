import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
} from "@agentscope/destinations-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentscopeConfigurationError,
  parseAgentscopeConfiguration,
  parseConfigurationCredentialReference,
  serializeAgentscopeConfiguration,
} from "./schema.js";

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const generationId =
  "credential-generation-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const referenceId =
  "credential-reference-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const settingsSchema = z.strictObject({ project: z.string() });
void settingsSchema.shape;
z.toJSONSchema(settingsSchema);
const descriptor = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-example",
  commandName: "example",
  settingsVersion: 3,
  settingsSchema,
  defaultSettings: { project: "default" },
  credentialSlots: [
    { id: "api-key", required: true },
    { id: "token", required: false },
  ],
  documentationPath: "/docs/destinations/example",
  deliveryIdentitySupport: "duplicates-possible",
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
});
const registry = compileDestinationRegistry([descriptor]);
const secondDescriptor = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-second",
  commandName: "second",
  settingsVersion: 3,
  settingsSchema,
  defaultSettings: { project: "default" },
  credentialSlots: [{ id: "api-key", required: true }],
  documentationPath: "/docs/destinations/second",
  deliveryIdentitySupport: "duplicates-possible",
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
});
const twoDescriptorRegistry = compileDestinationRegistry([
  descriptor,
  secondDescriptor,
]);

const knownNamespace = () => ({
  namespaceVersion: 1,
  settingsVersion: 3,
  connections: [
    {
      connectionId,
      name: "primary",
      settings: { project: "example" },
      credentialReferences: {
        "api-key": {
          referenceVersion: 1,
          backend: "macos-keychain",
          referenceId,
          generationId,
        },
      },
    },
  ],
});

const document = () => ({
  configurationVersion: 1,
  generation: 7,
  destinations: {
    "@agentscope/destination-example": knownNamespace(),
  },
  routing: { version: 1, selectedConnectionIds: [connectionId] },
  policy: { version: 1, reference: "core-redaction-policy-v1-baseline" },
});

describe("versioned Agentscope configuration", () => {
  it("validates known descriptor namespaces and reconstructs immutable state", () => {
    const input = document();
    input.destinations[
      "@agentscope/destination-example"
    ].connections[0]!.credentialReferences = {
      token: {
        referenceVersion: 1,
        backend: "macos-keychain",
        referenceId,
        generationId,
      },
      ...input.destinations["@agentscope/destination-example"].connections[0]!
        .credentialReferences,
    } as never;
    const snapshot = parseAgentscopeConfiguration(input, registry);
    expect(snapshot).toMatchObject({
      configurationVersion: 1,
      generation: 7,
      mutationSafe: true,
      policyReference: "core-redaction-policy-v1-baseline",
      selectedConnectionIds: [connectionId],
      unsupportedDestinationTypes: [],
    });
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0]).toMatchObject({
      connectionId,
      name: "primary",
      destinationType: "@agentscope/destination-example",
      settings: { project: "example" },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.document)).toBe(true);
    expect(snapshot.document).not.toBe(input);
    expect(JSON.parse(serializeAgentscopeConfiguration(snapshot))).toEqual(
      input,
    );
    expect(() =>
      serializeAgentscopeConfiguration({ ...snapshot }),
    ).toThrowError(AgentscopeConfigurationError);
  });
});

describe("configuration credentials and forward compatibility", () => {
  it("persists only closed credential references, never credential values", () => {
    const environment = document();
    environment.destinations[
      "@agentscope/destination-example"
    ].connections[0]!.credentialReferences["api-key"] = {
      referenceVersion: 1,
      backend: "ci-environment",
      environmentVariable: "LANGFUSE_SECRET_KEY",
      generationId,
    } as never;
    expect(
      Object.values(
        parseAgentscopeConfiguration(environment, registry).connections[0]!
          .credentialReferences,
      )[0],
    ).toMatchObject({
      backend: "ci-environment",
      environmentVariable: "LANGFUSE_SECRET_KEY",
    });
    for (const credentialReferences of [
      { "api-key": { value: "CANARY_SECRET" } },
      {},
      {
        "api-key": {
          referenceVersion: 1,
          backend: "ci-environment",
          environmentVariable: "bad-name",
          generationId,
        },
      },
      {
        "api-key": {
          referenceVersion: 1,
          backend: "macos-keychain",
          referenceId: "CANARY_SECRET",
          generationId,
        },
      },
      {
        "unknown-slot": {
          referenceVersion: 1,
          backend: "macos-keychain",
          referenceId,
          generationId,
        },
      },
    ]) {
      const candidate = document();
      candidate.destinations[
        "@agentscope/destination-example"
      ].connections[0]!.credentialReferences = credentialReferences as never;
      expect(() =>
        parseAgentscopeConfiguration(candidate, registry),
      ).toThrowError(AgentscopeConfigurationError);
    }
  });

  it("preserves unknown first-party destination namespaces without authorizing mutation", () => {
    const candidate = document();
    const futureType = "@agentscope/destination-future";
    Object.assign(candidate.destinations, {
      [futureType]: {
        futureNamespaceVersion: 9,
        futureSettings: { retained: ["exactly", 3, true] },
      },
    });
    candidate.routing.selectedConnectionIds = [];
    const snapshot = parseAgentscopeConfiguration(candidate, registry);
    expect(snapshot.mutationSafe).toBe(false);
    expect(snapshot.unsupportedDestinationTypes).toEqual([futureType]);
    expect(JSON.parse(serializeAgentscopeConfiguration(snapshot))).toEqual(
      candidate,
    );

    const newerKnownNamespace = document();
    newerKnownNamespace.destinations[
      "@agentscope/destination-example"
    ].settingsVersion = 4;
    newerKnownNamespace.routing.selectedConnectionIds = [];
    const newerSnapshot = parseAgentscopeConfiguration(
      newerKnownNamespace,
      registry,
    );
    expect(newerSnapshot.mutationSafe).toBe(false);
    expect(newerSnapshot.unsupportedDestinationTypes).toEqual([
      "@agentscope/destination-example",
    ]);
    expect(JSON.parse(serializeAgentscopeConfiguration(newerSnapshot))).toEqual(
      newerKnownNamespace,
    );
  });
});

describe("configuration rejection boundaries", () => {
  it("orders multiple current connections deterministically", () => {
    const candidate = document();
    candidate.destinations[
      "@agentscope/destination-example"
    ].connections.unshift({
      ...structuredClone(
        candidate.destinations["@agentscope/destination-example"]
          .connections[0]!,
      ),
      connectionId:
        "destination-connection-v1-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      name: "secondary",
    });
    candidate.routing.selectedConnectionIds = [];
    expect(
      parseAgentscopeConfiguration(candidate, registry).connections.map(
        (connection) => connection.name,
      ),
    ).toEqual(["primary", "secondary"]);
  });

  it("enforces connection, routing, and namespace invariants", () => {
    const cases: unknown[] = [];
    const malformedNamespaceHeader = document();
    malformedNamespaceHeader.destinations[
      "@agentscope/destination-example"
    ].settingsVersion = 0;
    cases.push(malformedNamespaceHeader);
    const wrongSettings = document();
    wrongSettings.destinations[
      "@agentscope/destination-example"
    ].connections[0]!.settings = { project: 3 } as never;
    cases.push(wrongSettings);
    const unknownRoute = document();
    unknownRoute.routing.selectedConnectionIds = [
      "destination-connection-v1-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ];
    cases.push(unknownRoute);
    const repeatedRoute = document();
    repeatedRoute.routing.selectedConnectionIds = [connectionId, connectionId];
    cases.push(repeatedRoute);
    const duplicateConnection = document();
    duplicateConnection.destinations[
      "@agentscope/destination-example"
    ].connections.push({
      ...structuredClone(
        duplicateConnection.destinations["@agentscope/destination-example"]
          .connections[0]!,
      ),
      name: "secondary",
    });
    cases.push(duplicateConnection);
    const duplicateName = document();
    duplicateName.destinations[
      "@agentscope/destination-example"
    ].connections.push({
      ...structuredClone(
        duplicateName.destinations["@agentscope/destination-example"]
          .connections[0]!,
      ),
      connectionId:
        "destination-connection-v1-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    cases.push(duplicateName);
    for (const candidate of cases)
      expect(() =>
        parseAgentscopeConfiguration(candidate, registry),
      ).toThrowError(AgentscopeConfigurationError);
  });

  it("enforces the aggregate connection bound across namespaces", () => {
    const candidate = document();
    const connection =
      candidate.destinations["@agentscope/destination-example"].connections[0]!;
    candidate.routing.selectedConnectionIds = [];
    candidate.destinations["@agentscope/destination-example"].connections =
      Array.from({ length: 64 }, (_, index) => ({
        ...structuredClone(connection),
        connectionId: `destination-connection-v1-${index
          .toString(16)
          .padStart(64, "0")}`,
        name: `connection-${index}`,
      }));
    Object.assign(candidate.destinations, {
      "@agentscope/destination-second": {
        ...knownNamespace(),
        connections: [
          {
            ...structuredClone(connection),
            connectionId:
              "destination-connection-v1-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            name: "overflow",
          },
        ],
      },
    });
    expect(() =>
      parseAgentscopeConfiguration(candidate, twoDescriptorRegistry),
    ).toThrowError(AgentscopeConfigurationError);
  });
});

describe("configuration hostile input boundaries", () => {
  it("parses only closed plain credential references", () => {
    expect(
      parseConfigurationCredentialReference({
        referenceVersion: 1,
        backend: "macos-keychain",
        referenceId,
        generationId,
      }),
    ).toMatchObject({ backend: "macos-keychain", referenceId });
    for (const input of [
      { backend: "macos-keychain" },
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("CANARY_SECRET");
          },
        },
      ),
    ])
      expect(() => parseConfigurationCredentialReference(input)).toThrowError(
        AgentscopeConfigurationError,
      );
  });

  it("rejects malformed outer documents and hostile object graphs", () => {
    const accessor = document() as Record<string, unknown>;
    Object.defineProperty(accessor, "generation", {
      get: () => {
        throw new Error("CANARY_SECRET");
      },
    });
    const cyclic = document() as Record<string, unknown>;
    cyclic.self = cyclic;
    const sparse = document();
    sparse.routing.selectedConnectionIds = new Array<string>(2);
    const extra = { ...document(), trace: { traceId: "raw" } };
    const tooManyNamespaces = document();
    tooManyNamespaces.destinations = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        `@agentscope/destination-future-${index}`,
        {},
      ]),
    ) as never;
    const tooManyRoutes = document();
    tooManyRoutes.routing.selectedConnectionIds = Array.from(
      { length: 33 },
      (_, index) =>
        `destination-connection-v1-${index.toString(16).padStart(64, "0")}`,
    );
    const invalidNamespace = document();
    invalidNamespace.destinations = { "third-party": {} } as never;
    const invalidConnection = document();
    invalidConnection.destinations[
      "@agentscope/destination-example"
    ].connections[0]!.name = "Invalid Name";
    for (const candidate of [
      null,
      [],
      { ...document(), configurationVersion: 2 },
      { ...document(), generation: -1 },
      { ...document(), policy: { version: 1, reference: "BAD POLICY" } },
      extra,
      accessor,
      cyclic,
      sparse,
      tooManyNamespaces,
      tooManyRoutes,
      invalidNamespace,
      invalidConnection,
    ])
      expect(() =>
        parseAgentscopeConfiguration(candidate, registry),
      ).toThrowError(AgentscopeConfigurationError);
  });
});
