import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLocalResourceLifecyclePlan,
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  completeLocalResourceLifecycle,
  createTraceLocator,
  inspectLocalResourceLifecyclePlan,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceConfigurationAuthorityForTesting,
  bindLocalResourceHomeAuthorityForTesting,
  bindLocalResourceLifecycleContextForTesting,
  createReporterDeadline,
  createRetrievalContext,
  createTraceGetRequest,
  createTraceSearchRequest,
  createLocalResourceLifecycleDeadlineForTesting,
  invokeDestinationReporterForTesting,
  invokeRetrieverGet,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
  prepareDestinationRetriever,
  prepareDestinationReporterForTesting,
  resolveDestinationConnection,
} from "@agentscope/destinations-core/testing";
import { createSanitizedRedactedCanonicalTraceFixture } from "@agentscope/protocol/testing";

import * as root from "./dist/index.js";

// LSA-006-basic-search-and-get

const compositionRoot = mkdtempSync(
  join(tmpdir(), "agentscope-local-sqlite-composition-"),
);
chmodSync(compositionRoot, 0o700);
try {
  const composition = root.initializeLocalSqliteProductionComposition(
    bindLocalResourceHomeAuthorityForTesting(
      Object.freeze({ root: compositionRoot, platform: process.platform }),
    ),
  );
  if (
    JSON.stringify(Object.keys(composition).sort()) !==
      JSON.stringify(["createLifecycleHandler", "destinationDescriptor"]) ||
    composition.destinationDescriptor !== root.localSqliteDestinationDescriptor
  )
    throw new Error("Local SQLite production composition surface drifted.");
  if (process.platform === "linux" && process.arch === "x64") {
    const handler = composition.createLifecycleHandler(
      root.localSqliteDestinationDescriptor.localResourceLifecycle,
    );
    if (
      JSON.stringify(Object.keys(handler)) !==
        JSON.stringify(["localResourceLifecycleHandler"]) ||
      handler.localResourceLifecycleHandler !== "agentscope-destinations-core"
    )
      throw new Error(
        "Local SQLite built production composition did not bind.",
      );
    const registry = compileDestinationRegistry([
      composition.destinationDescriptor,
    ]);
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    const lifecycleContext = bindLocalResourceLifecycleContextForTesting({
      operation: "configure",
      operationId: "c".repeat(32),
      destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"a".repeat(64)}`,
      connectionName: "built-local",
      owner: {
        processId: process.pid,
        processStartIdentity: `process-start-v1-${"d".repeat(64)}`,
      },
      settings: {
        maximumAgeNanoseconds: "2592000000000000",
        maximumPayloadBytes: 1_000_000,
        maximumTraceCount: 10_000,
      },
      expectedConfigurationGeneration: 0,
      candidateConfigurationGeneration: 1,
      expectedConfigurationDigest: `sha256-${"e".repeat(64)}`,
      candidateConfigurationDigest: `sha256-${"f".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    const planEvidence = await inspectLocalResourceLifecyclePlan(
      handlers,
      lifecycleContext,
    );
    const configurationAuthority =
      bindLocalResourceConfigurationAuthorityForTesting({
        destinationType: lifecycleContext.destinationType,
        connectionId: lifecycleContext.connectionId,
        operationId: lifecycleContext.operationId,
        lifecycleFingerprint:
          root.localSqliteDestinationDescriptor.localResourceLifecycle
            .fingerprint,
        recoveryHandlerId:
          root.localSqliteDestinationDescriptor.localResourceLifecycle
            .recoveryHandlerId,
        priorGeneration: lifecycleContext.expectedConfigurationGeneration,
        candidateGeneration: lifecycleContext.candidateConfigurationGeneration,
        candidateDigest: lifecycleContext.candidateConfigurationDigest,
        commit: () =>
          Promise.resolve({
            priorGeneration: lifecycleContext.expectedConfigurationGeneration,
            committedGeneration:
              lifecycleContext.candidateConfigurationGeneration,
            candidateDigest: lifecycleContext.candidateConfigurationDigest,
          }),
      });
    const configured = await applyLocalResourceLifecyclePlan(
      handlers,
      lifecycleContext,
      planEvidence,
      configurationAuthority,
    );
    if (!configured.ok || configured.state !== "configured")
      throw new Error(
        "Local SQLite built production composition did not configure.",
      );
    await completeLocalResourceLifecycle(handlers, lifecycleContext);
    const productReporter = prepareDestinationReporterForTesting({
      descriptor: composition.destinationDescriptor,
      credentials: {},
      executor: () => {
        throw new Error("Local SQLite production descriptor used transport.");
      },
      settings: lifecycleContext.settings,
    });
    const trace = createSanitizedRedactedCanonicalTraceFixture();
    const receipt = await invokeDestinationReporterForTesting(productReporter, {
      traces: [trace],
      admissionTimeUnixNano: "200",
      timeoutMilliseconds: 5_000,
    });
    if (receipt.outcome !== "accepted")
      throw new Error(
        `Local SQLite built production descriptor did not execute: ${receipt.outcome}.`,
      );
    const preparedConnection = resolveDestinationConnection(
      composition.destinationDescriptor,
      {
        connectionId: lifecycleContext.connectionId,
        settings: lifecycleContext.settings,
      },
    );
    const productRetriever = prepareDestinationRetriever(preparedConnection, {
      credentials: {},
      transport: null,
    });
    const retrievalContext = () =>
      createRetrievalContext({
        deadline: createReporterDeadline(5_000),
        maximumProviderRequests: 1,
        maximumResponseBytes: 1_000_000,
        signal: new AbortController().signal,
      });
    const query = normalizeTraceSearchQuery(
      { limit: 10 },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["fixture-harness"],
        ordering: "start-time-desc-trace-id-asc",
      },
    );
    const search = await invokeRetrieverSearch(
      productRetriever,
      createTraceSearchRequest(query, {
        connectionId: lifecycleContext.connectionId,
        destinationType: composition.destinationDescriptor.destinationType,
      }),
      retrievalContext(),
    );
    if (!search.ok || search.value.summaries.length !== 1)
      throw new Error("Local SQLite built production search did not match.");
    const locator = search.value.summaries[0]?.locator;
    if (!locator)
      throw new Error(
        "Local SQLite built production search omitted its locator.",
      );
    const get = await invokeRetrieverGet(
      productRetriever,
      createTraceGetRequest(
        createTraceLocator({
          connectionId: lifecycleContext.connectionId,
          destinationType: composition.destinationDescriptor.destinationType,
          traceId: locator.traceId,
        }),
        {
          connectionId: lifecycleContext.connectionId,
          destinationType: composition.destinationDescriptor.destinationType,
        },
      ),
      retrievalContext(),
    );
    if (!get.ok || get.value.representation.kind !== "persisted-envelope")
      throw new Error("Local SQLite built production get did not match.");

    const missing = await invokeRetrieverGet(
      productRetriever,
      createTraceGetRequest(
        createTraceLocator({
          connectionId: lifecycleContext.connectionId,
          destinationType: composition.destinationDescriptor.destinationType,
          traceId: "f".repeat(32),
        }),
        {
          connectionId: lifecycleContext.connectionId,
          destinationType: composition.destinationDescriptor.destinationType,
        },
      ),
      retrievalContext(),
    );
    if (missing.ok || missing.code !== "not-found")
      throw new Error("Local SQLite built production get failure drifted.");
  }
} finally {
  rmSync(compositionRoot, { recursive: true, force: true });
}
