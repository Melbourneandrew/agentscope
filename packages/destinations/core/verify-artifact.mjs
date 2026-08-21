import { z } from "zod";

import {
  createDestinationConnectionId,
  createDestinationReporter,
  createReporterReceipt,
  createDestinationRetriever,
  createRetrieverFailure,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  applyLocalResourceLifecyclePlan,
  commitLocalResourceConfiguration,
  completeLocalResourceLifecycle,
  defineDestinationReachabilityProbe,
  defineDestinationDescriptor,
  defineLocalResourceLifecycleHandler,
  defineLocalResourceLifecycleDeclaration,
  DestinationLocalResourceLifecycleError,
  executeBoundDestinationRequest,
  isDestinationReachabilityProbe,
  parseDestinationSettings,
  TRACE_SEARCH_ORDERINGS,
  recoverLocalResourceLifecycle,
} from "./dist/index.js";
import {
  bindLocalResourceConfigurationAuthorityForCore,
  bindLocalResourceLifecycleContextForCore,
  bindDestinationTransport,
  bindLocalResourceLifecycleRecoveryContextForCore,
  createLocalResourceLifecycleDeadlineForCore,
  createRetrievalContext,
  createReporterDeadline,
  createTraceSearchCursor,
  createTraceSearchRequest,
  invokeReporter,
  invokeRetrieverSearch,
  normalizeTraceSearchQuery,
  prepareDestinationReporter,
  prepareDestinationRetriever,
  readTraceSearchCursor,
  resolveDestinationConnection,
} from "./dist/core-orchestration.js";
import {
  createDestinationTestAdapter,
  createReporterContractSuite,
  createRetrieverContractQueryMatrix,
  createRetrieverTestAdapter,
  RETRIEVER_CONTRACT_FIXTURE_VALUES,
  RETRIEVER_CONTRACT_QUERY_CASE_NAMES,
  invokeDestinationReporterForTesting,
  prepareDestinationReporterForTesting,
} from "./dist/testing.js";

const connectionId = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
if (
  !Object.isFrozen(TRACE_SEARCH_ORDERINGS) ||
  TRACE_SEARCH_ORDERINGS.join("|") !==
    "start-time-desc-trace-id-asc|start-time-desc-provider"
)
  throw new Error("Retriever ordering vocabulary drifted.");
const reachabilityProbe = defineDestinationReachabilityProbe({
  destinationType: "@agentscope/destination-example",
  inspect: () => Promise.resolve("available"),
});
if (
  !isDestinationReachabilityProbe(reachabilityProbe) ||
  isDestinationReachabilityProbe({ ...reachabilityProbe })
)
  throw new Error("Destination reachability brand is unavailable.");
for (const destinationType of [
  "@agentscope/destination--invalid",
  "@agentscope/destination-invalid-",
]) {
  try {
    defineDestinationReachabilityProbe({
      destinationType,
      inspect: () => Promise.resolve("available"),
    });
  } catch (error) {
    if (error?.code === "destination.reachability.invalid") continue;
  }
  throw new Error("Destination reachability identity drift was accepted.");
}
const schema = z.strictObject({ endpoint: z.string() });
void schema.shape;
const materializeRoot = (candidate) => {
  void candidate.shape;
  return candidate;
};
const input = (overrides = {}) => ({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-artifact",
  commandName: "artifact",
  settingsVersion: 1,
  settingsSchema: schema,
  defaultSettings: { endpoint: "https://example.com" },
  credentialSlots: [],
  documentationPath: "/docs/destinations/artifact",
  deliveryIdentitySupport: "duplicates-possible",
  transport: {
    kind: "remote",
    resolveEndpoint: ({ endpoint }) => ({
      url: endpoint,
      allowInsecureLoopback: false,
    }),
  },
  createReporter: () => ({ report: () => Promise.resolve({}) }),
  ...overrides,
});

const expectFixedRejection = (action) => {
  try {
    action();
  } catch (error) {
    if (error?.code === "destination.descriptor.invalid") return;
  }
  throw new Error("Destination artifact callback misuse was not rejected.");
};

const lifecycleDeclaration = defineLocalResourceLifecycleDeclaration({
  artifactGrammarFingerprint: `sha256-${"a".repeat(64)}`,
  artifactGrammarVersion: 1,
  artifactKinds: ["active-database", "lifecycle-intent"],
  capabilityVersion: 1,
  destinationType: "@agentscope/destination-local-sqlite",
  operations: ["configure", "recover"],
  receiptReasons: ["destination-busy"],
  recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
  settingKeys: ["endpoint"],
  settingsVersion: 1,
});
if (
  new DestinationLocalResourceLifecycleError().code !==
  "destination.local-resource-lifecycle.invalid"
)
  throw new Error("Built lifecycle fixed error code drifted.");
if (lifecycleDeclaration.operations.join("|") !== "configure|recover")
  throw new Error("Built local-resource lifecycle authority drifted.");
expectFixedRejection(() =>
  defineDestinationDescriptor(
    input({
      localResourceLifecycle: lifecycleDeclaration,
    }),
  ),
);
const localLifecycleDescriptor = defineDestinationDescriptor(
  input({
    commandName: "local-sqlite",
    credentialSlots: [],
    destinationType: "@agentscope/destination-local-sqlite",
    localResourceLifecycle: lifecycleDeclaration,
    transport: { kind: "local" },
  }),
);
if (
  !/^sha256-[a-f0-9]{64}$/u.test(
    localLifecycleDescriptor.localResourceLifecycle.fingerprint,
  ) ||
  !/^sha256-[a-f0-9]{64}$/u.test(
    localLifecycleDescriptor.localResourceLifecycle.settingsSchemaFingerprint,
  )
)
  throw new Error("Built descriptor lost local-resource lifecycle authority.");
const historicalLifecycleDeclaration = defineLocalResourceLifecycleDeclaration({
  ...lifecycleDeclaration,
  artifactGrammarFingerprint: `sha256-${"b".repeat(64)}`,
});
const historicalLifecycleDescriptor = defineDestinationDescriptor(
  input({
    commandName: "local-sqlite",
    credentialSlots: [],
    destinationType: "@agentscope/destination-local-sqlite",
    localResourceLifecycle: historicalLifecycleDeclaration,
    transport: { kind: "local" },
  }),
);
const lifecycleRegistry = compileDestinationRegistry([
  localLifecycleDescriptor,
]);
let historicalRecoveries = 0;
let historicalCompletions = 0;
const unusedLifecycleCallback = () => Promise.reject(new Error("unused"));
const lifecycleHandlers = compileLocalResourceLifecycleHandlerRegistry(
  lifecycleRegistry,
  [
    defineLocalResourceLifecycleHandler({
      capability: localLifecycleDescriptor.localResourceLifecycle,
      complete: unusedLifecycleCallback,
      inspectPlan: unusedLifecycleCallback,
      inspectRetainedDelete: unusedLifecycleCallback,
      apply: unusedLifecycleCallback,
      recover: unusedLifecycleCallback,
    }),
    defineLocalResourceLifecycleHandler({
      capability: historicalLifecycleDescriptor.localResourceLifecycle,
      complete: () => {
        historicalCompletions += 1;
        return Promise.resolve();
      },
      inspectPlan: unusedLifecycleCallback,
      inspectRetainedDelete: unusedLifecycleCallback,
      apply: unusedLifecycleCallback,
      recover: () => {
        historicalRecoveries += 1;
        return Promise.resolve({ ok: true, state: "rolled-back" });
      },
    }),
  ],
);
const historicalRecoveryContext =
  bindLocalResourceLifecycleRecoveryContextForCore({
    operation: "configure",
    operationId: "1".repeat(32),
    destinationType: "@agentscope/destination-local-sqlite",
    connectionId,
    owner: {
      processId: 1,
      processStartIdentity: `process-start-v1-${"2".repeat(64)}`,
    },
    lifecycleFingerprint:
      historicalLifecycleDescriptor.localResourceLifecycle.fingerprint,
    recoveryHandlerId:
      historicalLifecycleDescriptor.localResourceLifecycle.recoveryHandlerId,
    expectedConfigurationGeneration: 1,
    expectedConfigurationDigest: `sha256-${"3".repeat(64)}`,
    authorizedCandidates: [
      { generation: 2, digest: `sha256-${"4".repeat(64)}` },
    ],
    configurationState: "prior",
    signal: new AbortController().signal,
    deadline: createLocalResourceLifecycleDeadlineForCore(1_000),
  });
const historicalRecoveryResult = await recoverLocalResourceLifecycle(
  lifecycleHandlers,
  historicalRecoveryContext,
);
await completeLocalResourceLifecycle(
  lifecycleHandlers,
  historicalRecoveryContext,
);
if (
  !historicalRecoveryResult.ok ||
  historicalRecoveryResult.state !== "rolled-back" ||
  historicalRecoveries !== 1 ||
  historicalCompletions !== 1
)
  throw new Error("Built historical lifecycle recovery dispatch drifted.");

let releaseCancelledApply;
let enterCancelledApply;
const cancelledApplyBlocked = new Promise((resolve) => {
  releaseCancelledApply = resolve;
});
const cancelledApplyEntered = new Promise((resolve) => {
  enterCancelledApply = resolve;
});
let cancelledAuthorityDenied = false;
let cancelledAuthorityCommits = 0;
const cancellationHandlers = compileLocalResourceLifecycleHandlerRegistry(
  lifecycleRegistry,
  [
    defineLocalResourceLifecycleHandler({
      capability: localLifecycleDescriptor.localResourceLifecycle,
      complete: unusedLifecycleCallback,
      inspectPlan: unusedLifecycleCallback,
      inspectRetainedDelete: unusedLifecycleCallback,
      recover: unusedLifecycleCallback,
      apply: async (context) => {
        enterCancelledApply();
        await cancelledApplyBlocked;
        try {
          await commitLocalResourceConfiguration(
            context.configurationAuthority,
            {
              destinationType: context.destinationType,
              connectionId: context.connectionId,
              operationId: context.operationId,
              lifecycleFingerprint:
                localLifecycleDescriptor.localResourceLifecycle.fingerprint,
              recoveryHandlerId:
                localLifecycleDescriptor.localResourceLifecycle
                  .recoveryHandlerId,
            },
          );
        } catch (error) {
          cancelledAuthorityDenied =
            error?.code === "destination.local-resource-configuration.invalid";
        }
        return { ok: true, state: "configured" };
      },
    }),
  ],
);
const cancellationSource = new AbortController();
const cancellationContext = bindLocalResourceLifecycleContextForCore({
  operation: "configure",
  operationId: "5".repeat(32),
  destinationType: localLifecycleDescriptor.destinationType,
  connectionId,
  connectionName: "local",
  owner: {
    processId: 1,
    processStartIdentity: `process-start-v1-${"6".repeat(64)}`,
  },
  settings: { endpoint: "local" },
  expectedConfigurationGeneration: 1,
  candidateConfigurationGeneration: 2,
  expectedConfigurationDigest: `sha256-${"7".repeat(64)}`,
  candidateConfigurationDigest: `sha256-${"8".repeat(64)}`,
  signal: cancellationSource.signal,
  deadline: createLocalResourceLifecycleDeadlineForCore(1_000),
});
const cancellationAuthority = bindLocalResourceConfigurationAuthorityForCore({
  destinationType: cancellationContext.destinationType,
  connectionId: cancellationContext.connectionId,
  operationId: cancellationContext.operationId,
  lifecycleFingerprint:
    localLifecycleDescriptor.localResourceLifecycle.fingerprint,
  recoveryHandlerId:
    localLifecycleDescriptor.localResourceLifecycle.recoveryHandlerId,
  priorGeneration: 1,
  candidateGeneration: 2,
  candidateDigest: cancellationContext.candidateConfigurationDigest,
  commit: () => {
    cancelledAuthorityCommits += 1;
    return Promise.resolve({
      priorGeneration: 1,
      committedGeneration: 2,
      candidateDigest: cancellationContext.candidateConfigurationDigest,
    });
  },
});
const cancelledApply = applyLocalResourceLifecyclePlan(
  cancellationHandlers,
  cancellationContext,
  {
    namespaceFingerprint: `sha256-${"9".repeat(64)}`,
    physicalEvidenceFingerprint: `sha256-${"a".repeat(64)}`,
    displayPath: "/owned",
    persistentDataNotice: true,
    retentionPolicy: {
      maximumAgeNanoseconds: "1",
      maximumTraceCount: 1,
      maximumPayloadBytes: 1,
      physicalCleanupTrigger: "next-authorized-mutation",
    },
  },
  cancellationAuthority,
);
await cancelledApplyEntered;
let cancelledApplySettled = false;
void cancelledApply.then(
  () => {
    cancelledApplySettled = true;
  },
  () => {
    cancelledApplySettled = true;
  },
);
cancellationSource.abort();
await Promise.resolve();
if (cancelledApplySettled)
  throw new Error("Built mutation returned before callback settlement.");
releaseCancelledApply();
try {
  await cancelledApply;
  throw new Error("Built cancelled mutation was accepted.");
} catch (error) {
  if (error?.code !== "destination.local-resource-handler.invalid") throw error;
}
if (!cancelledAuthorityDenied || cancelledAuthorityCommits !== 0)
  throw new Error("Built cancelled mutation retained Configuration authority.");

let releaseDetachedCommit;
const detachedCommitBlocked = new Promise((resolve) => {
  releaseDetachedCommit = resolve;
});
let detachedCommitMutation = false;
let detachedCommitError;
const detachedHandlers = compileLocalResourceLifecycleHandlerRegistry(
  lifecycleRegistry,
  [
    defineLocalResourceLifecycleHandler({
      capability: localLifecycleDescriptor.localResourceLifecycle,
      complete: unusedLifecycleCallback,
      inspectPlan: unusedLifecycleCallback,
      inspectRetainedDelete: unusedLifecycleCallback,
      recover: unusedLifecycleCallback,
      apply: (context) => {
        void commitLocalResourceConfiguration(context.configurationAuthority, {
          destinationType: context.destinationType,
          connectionId: context.connectionId,
          operationId: context.operationId,
          lifecycleFingerprint:
            localLifecycleDescriptor.localResourceLifecycle.fingerprint,
          recoveryHandlerId:
            localLifecycleDescriptor.localResourceLifecycle.recoveryHandlerId,
        }).catch((error) => {
          detachedCommitError = error;
        });
        return Promise.resolve({ ok: true, state: "configured" });
      },
    }),
  ],
);
const detachedContext = bindLocalResourceLifecycleContextForCore({
  ...cancellationContext,
  operationId: "b".repeat(32),
  candidateConfigurationDigest: `sha256-${"c".repeat(64)}`,
  signal: new AbortController().signal,
  deadline: createLocalResourceLifecycleDeadlineForCore(1_000),
});
const detachedAuthority = bindLocalResourceConfigurationAuthorityForCore({
  destinationType: detachedContext.destinationType,
  connectionId: detachedContext.connectionId,
  operationId: detachedContext.operationId,
  lifecycleFingerprint:
    localLifecycleDescriptor.localResourceLifecycle.fingerprint,
  recoveryHandlerId:
    localLifecycleDescriptor.localResourceLifecycle.recoveryHandlerId,
  priorGeneration: 1,
  candidateGeneration: 2,
  candidateDigest: detachedContext.candidateConfigurationDigest,
  commit: async () => {
    await detachedCommitBlocked;
    detachedCommitMutation = true;
    return {
      priorGeneration: 1,
      committedGeneration: 2,
      candidateDigest: detachedContext.candidateConfigurationDigest,
    };
  },
});
const detachedApply = applyLocalResourceLifecyclePlan(
  detachedHandlers,
  detachedContext,
  {
    namespaceFingerprint: `sha256-${"9".repeat(64)}`,
    physicalEvidenceFingerprint: `sha256-${"a".repeat(64)}`,
    displayPath: "/owned",
    persistentDataNotice: true,
    retentionPolicy: {
      maximumAgeNanoseconds: "1",
      maximumTraceCount: 1,
      maximumPayloadBytes: 1,
      physicalCleanupTrigger: "next-authorized-mutation",
    },
  },
  detachedAuthority,
);
let detachedApplySettled = false;
void detachedApply.then(() => {
  detachedApplySettled = true;
});
await Promise.resolve();
await Promise.resolve();
if (detachedApplySettled || detachedCommitMutation)
  throw new Error("Built detached Configuration commit was not joined.");
releaseDetachedCommit();
const detachedResult = await detachedApply;
if (
  !detachedResult.ok ||
  detachedResult.state !== "configured" ||
  !detachedCommitMutation ||
  detachedCommitError
)
  throw new Error("Built detached Configuration commit settlement drifted.");

const unhandled = [];
const collectUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", collectUnhandled);
try {
  let reporterCalls = 0;
  const reasonReporter = createDestinationReporter({
    report: ({ admissionTimeUnixNano }) => {
      reporterCalls += 1;
      if (admissionTimeUnixNano !== "1000000")
        throw new Error("Reporter admission time drifted.");
      return Promise.resolve(
        createReporterReceipt("unavailable", "destination-busy"),
      );
    },
  });
  const reporterAttempt = {
    traces: [{}],
    signal: new AbortController().signal,
    deadline: createReporterDeadline(1_000),
    admissionTimeUnixNano: "1000000",
  };
  const reasonReceipt = createReporterReceipt(
    "unavailable",
    "destination-busy",
  );
  if (
    reasonReceipt.outcome !== "unavailable" ||
    reasonReceipt.reason !== "destination-busy" ||
    reporterCalls !== 0
  )
    throw new Error("Built Reporter reason authority drifted.");
  try {
    await invokeReporter(reasonReporter, {
      ...reporterAttempt,
      admissionTimeUnixNano: "01",
    });
    throw new Error("Built Reporter accepted an invalid admission time.");
  } catch (error) {
    if (error?.code !== "destination.reporter.invalid") throw error;
  }
  if (reporterCalls !== 0)
    throw new Error("Invalid admission time reached the built Reporter.");

  const reporterCases = createReporterContractSuite({
    adapter: createDestinationTestAdapter(),
    traces: [{}],
  });
  const queryMatrix = createRetrieverContractQueryMatrix({
    primaryTraceId: "0123456789abcdef0123456789abcdef",
    secondaryTraceId: "1123456789abcdef0123456789abcdef",
    ordering: "start-time-desc-trace-id-asc",
  });
  const limitCase = queryMatrix.find(({ name }) => name === "limit");
  const continuationCase = queryMatrix.find(
    ({ name }) => name === "continuation",
  );
  if (
    !reporterCases.some(({ name }) => name === "reporter:accept") ||
    typeof prepareDestinationReporterForTesting !== "function" ||
    typeof invokeDestinationReporterForTesting !== "function" ||
    typeof createRetrieverTestAdapter !== "function" ||
    RETRIEVER_CONTRACT_QUERY_CASE_NAMES.length !== 22 ||
    queryMatrix.length !== RETRIEVER_CONTRACT_QUERY_CASE_NAMES.length ||
    queryMatrix[0]?.expectedTraceIds.length !== 2 ||
    limitCase?.expectedState !== "continuation" ||
    continuationCase?.expectedState !== "exhaustive" ||
    JSON.stringify(limitCase.expectedContinuationToken) !==
      JSON.stringify(continuationCase.continuationToken) ||
    RETRIEVER_CONTRACT_FIXTURE_VALUES.branch !== "main"
  )
    throw new Error("Destination testing subpath is incomplete.");

  const methodSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(methodSchema);
  const methodDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: methodSchema }),
  );
  Object.defineProperty(methodSchema, "safeParse", {
    value: (value) => ({ success: true, data: value }),
  });
  Object.defineProperty(methodSchema._zod, "run", {
    value: (value) => value,
  });
  expectFixedRejection(() =>
    parseDestinationSettings(methodDescriptor, { endpoint: 42 }),
  );

  const shapeSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(shapeSchema);
  const shapeDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: shapeSchema }),
  );
  Object.defineProperty(shapeSchema.def, "shape", {
    value: { endpoint: z.number() },
  });
  expectFixedRejection(() =>
    parseDestinationSettings(shapeDescriptor, {
      endpoint: 42,
    }),
  );

  const preparedExact = resolveDestinationConnection(methodDescriptor, {
    connectionId,
    settings: { endpoint: "https://example.com/tenant-a/" },
  });
  const preparedOtherPath = resolveDestinationConnection(methodDescriptor, {
    connectionId,
    settings: { endpoint: "https://example.com/tenant-b/" },
  });
  let transportCalls = 0;
  const otherPathTransport = bindDestinationTransport(
    preparedOtherPath.endpoint,
    async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
  );
  expectFixedRejection(() =>
    prepareDestinationReporter(preparedExact, {
      credentials: {},
      transport: otherPathTransport,
    }),
  );
  try {
    await executeBoundDestinationRequest(otherPathTransport, {
      method: "POST",
      pathAndQuery: "https://example.com/absolute",
      headers: {},
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
    });
    throw new Error("Absolute destination request was accepted.");
  } catch (error) {
    if (error?.code !== "destination.transport.invalid") throw error;
  }
  if (transportCalls !== 0)
    throw new Error("Invalid destination request reached the executor.");

  const retrieverDescriptor = defineDestinationDescriptor(
    input({
      retrievalOrdering: "start-time-desc-trace-id-asc",
      createRetriever: () =>
        createDestinationRetriever({
          search: () =>
            Promise.resolve(createRetrieverFailure("retrieval-unsupported")),
          get: () => Promise.resolve(createRetrieverFailure("not-found")),
        }),
    }),
  );
  const retrieverPrepared = resolveDestinationConnection(retrieverDescriptor, {
    connectionId,
    settings: { endpoint: "https://example.com/tenant-a/" },
  });
  const retrieverTransport = bindDestinationTransport(
    retrieverPrepared.endpoint,
    async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  );
  const retriever = prepareDestinationRetriever(retrieverPrepared, {
    credentials: {},
    transport: retrieverTransport,
  });
  const query = normalizeTraceSearchQuery(
    {},
    {
      commandStartedAt: "2026-08-17T00:00:00Z",
      knownHarnessIds: ["codex"],
      ordering: "start-time-desc-trace-id-asc",
    },
  );
  const cursorBinding = {
    connectionId,
    destinationType: retrieverDescriptor.destinationType,
    configurationIdentity: "artifact-config-v1",
    queryFingerprint: query.fingerprint,
    upperTimeBound: query.to,
  };
  const cursor = createTraceSearchCursor(cursorBinding, { offset: 1 });
  if (readTraceSearchCursor(cursor, cursorBinding).offset !== 1)
    throw new Error("Retriever cursor lost its provider token.");
  for (const rewritten of [`${cursor}!`, `${cursor}=`]) {
    try {
      readTraceSearchCursor(rewritten, cursorBinding);
      throw new Error("Non-canonical Retriever cursor was accepted.");
    } catch (error) {
      if (error?.code !== "destination.trace-cursor.invalid") throw error;
    }
  }
  const retrievalResult = await invokeRetrieverSearch(
    retriever,
    createTraceSearchRequest(
      query,
      {
        connectionId,
        destinationType: retrieverDescriptor.destinationType,
      },
      readTraceSearchCursor(cursor, cursorBinding),
    ),
    createRetrievalContext({
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 1_024,
      maximumProviderRequests: 1,
    }),
  );
  if (
    retrievalResult.ok ||
    retrievalResult.code !== "retrieval-unsupported" ||
    retrieverDescriptor.retrievalSupport !== "search-and-get" ||
    retrieverDescriptor.retrievalOrdering !== "start-time-desc-trace-id-asc"
  )
    throw new Error("Retriever dist contract verification failed.");
  const providerQuery = normalizeTraceSearchQuery(
    {},
    {
      commandStartedAt: query.to,
      knownHarnessIds: ["codex"],
      ordering: "start-time-desc-provider",
    },
  );
  if (providerQuery.fingerprint === query.fingerprint)
    throw new Error("Retriever ordering was omitted from query identity.");
  try {
    readTraceSearchCursor(cursor, {
      ...cursorBinding,
      queryFingerprint: providerQuery.fingerprint,
    });
    throw new Error("Retriever cursor crossed ordering profiles.");
  } catch (error) {
    if (error?.code !== "destination.trace-cursor.invalid") throw error;
  }
  const providerSummaries = [
    "f123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef",
  ].map((traceId) =>
    createTraceSummary({
      locator: createTraceLocator({
        connectionId,
        destinationType: retrieverDescriptor.destinationType,
        traceId,
      }),
      startTime: "2026-08-17T00:00:00.000Z",
      models: [],
      status: "ok",
      spanCount: 1,
      tags: [],
    }),
  );
  const providerPage = createRetrieverSearchPage({
    summaries: providerSummaries,
    state: "exhaustive",
    consistency: "best-effort",
    ordering: "start-time-desc-provider",
  });
  const providerRetriever = createDestinationRetriever({
    search: () => Promise.resolve(createRetrieverSuccess(providerPage)),
    get: () => Promise.resolve(createRetrieverFailure("not-found")),
  });
  const operationContext = () =>
    createRetrievalContext({
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 4_096,
      maximumProviderRequests: 1,
    });
  const providerResult = await invokeRetrieverSearch(
    providerRetriever,
    createTraceSearchRequest(providerQuery, {
      connectionId,
      destinationType: retrieverDescriptor.destinationType,
    }),
    operationContext(),
  );
  if (!providerResult.ok)
    throw new Error("Provider-ordered equal-time page was rejected.");
  const mismatchedOrdering = await invokeRetrieverSearch(
    providerRetriever,
    createTraceSearchRequest(query, {
      connectionId,
      destinationType: retrieverDescriptor.destinationType,
    }),
    operationContext(),
  );
  if (mismatchedOrdering.ok || mismatchedOrdering.code !== "malformed-response")
    throw new Error("Forged Retriever ordering profile was accepted.");
  const otherConnectionId = createDestinationConnectionId(
    "destination-connection-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  const wrongSummary = createTraceSummary({
    locator: createTraceLocator({
      connectionId: otherConnectionId,
      destinationType: retrieverDescriptor.destinationType,
      traceId: "0123456789abcdef0123456789abcdef",
    }),
    startTime: "2026-08-17T00:00:00.000Z",
    models: [],
    status: "ok",
    spanCount: 1,
    tags: [],
  });
  const wrongPage = createRetrieverSearchPage({
    summaries: [wrongSummary],
    state: "exhaustive",
    consistency: "snapshot",
    ordering: "start-time-desc-trace-id-asc",
  });
  const swappingRetriever = createDestinationRetriever({
    search: () => Promise.resolve(createRetrieverSuccess(wrongPage)),
    get: () => Promise.resolve(createRetrieverFailure("not-found")),
  });
  const swapped = await invokeRetrieverSearch(
    swappingRetriever,
    createTraceSearchRequest(query, {
      connectionId,
      destinationType: retrieverDescriptor.destinationType,
    }),
    createRetrievalContext({
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
      maximumResponseBytes: 4_096,
      maximumProviderRequests: 1,
    }),
  );
  if (swapped.ok || swapped.code !== "malformed-response")
    throw new Error("Retriever accepted a cross-connection summary.");
  const asyncRetrieverDescriptor = defineDestinationDescriptor(
    input({
      retrievalOrdering: "start-time-desc-trace-id-asc",
      createRetriever: async () => {
        throw new Error("CANARY_RETRIEVER_SECRET");
      },
    }),
  );
  const asyncRetrieverPrepared = resolveDestinationConnection(
    asyncRetrieverDescriptor,
    {
      connectionId,
      settings: { endpoint: "https://example.com/tenant-a/" },
    },
  );
  const asyncRetrieverTransport = bindDestinationTransport(
    asyncRetrieverPrepared.endpoint,
    async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  );
  expectFixedRejection(() =>
    prepareDestinationRetriever(asyncRetrieverPrepared, {
      credentials: {},
      transport: asyncRetrieverTransport,
    }),
  );
  await Promise.resolve();
  await Promise.resolve();

  let weakened = false;
  const refinementSchema = z.strictObject({
    endpoint: z
      .string()
      .refine((value) => weakened || value === "https://example.com"),
  });
  materializeRoot(refinementSchema);
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: refinementSchema })),
  );
  weakened = true;

  const propertySchema = z
    .strictObject({ endpoint: z.string() })
    .check(z.property("endpoint", z.string().min(20)));
  materializeRoot(propertySchema);
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: propertySchema })),
  );

  for (const pattern of [/abc/i, /^abc$/m, /abc/u]) {
    const flaggedRegexSchema = z.strictObject({
      endpoint: z.string().regex(pattern),
    });
    materializeRoot(flaggedRegexSchema);
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({ settingsSchema: flaggedRegexSchema }),
      ),
    );
  }
  for (const nonRoundTrippableString of [
    z.string().emoji(),
    z.string().includes("b", { position: 2 }),
  ]) {
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({
          settingsSchema: materializeRoot(
            z.strictObject({ endpoint: nonRoundTrippableString }),
          ),
        }),
      ),
    );
  }
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.number().min(3, { when: () => false }),
          }),
        ),
      }),
    ),
  );
  for (const metadataSchema of [
    z.string().regex(/^x$/).meta({ pattern: ".*" }),
    z.string().check(z.meta({ pattern: ".*" })),
  ]) {
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({
          settingsSchema: materializeRoot(
            z.strictObject({ endpoint: metadataSchema }),
          ),
        }),
      ),
    );
  }
  const customEmitterSchema = z.strictObject({
    endpoint: z.string().regex(/^x$/),
  });
  materializeRoot(customEmitterSchema);
  Object.defineProperty(customEmitterSchema._zod, "toJSONSchema", {
    value: () => ({
      type: "object",
      properties: { endpoint: { type: "string" } },
      required: ["endpoint"],
      additionalProperties: false,
    }),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: customEmitterSchema })),
  );

  const inheritedEmitterSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(inheritedEmitterSchema);
  Object.setPrototypeOf(inheritedEmitterSchema._zod, {
    toJSONSchema: () => ({ type: "object" }),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({ settingsSchema: inheritedEmitterSchema }),
    ),
  );
  const tamperedBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  tamperedBagLeaf._zod.bag.patterns = new Set([/.*/]);
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: tamperedBagLeaf }),
        ),
      }),
    ),
  );
  const inheritedBagLeaf = z.string();
  Object.setPrototypeOf(inheritedBagLeaf._zod.bag, {
    patterns: new Set([/^x$/]),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: inheritedBagLeaf }),
        ),
      }),
    ),
  );
  const shadowedPattern = /^https:\/\/example\.com$/;
  Object.defineProperty(shadowedPattern, "source", { get: () => ".*" });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.string().regex(shadowedPattern),
          }),
        ),
      }),
    ),
  );
  const inheritedPattern = /^https:\/\/example\.com$/;
  Object.setPrototypeOf(inheritedPattern, {
    get source() {
      return ".*";
    },
    get flags() {
      return "";
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.string().regex(inheritedPattern),
          }),
        ),
      }),
    ),
  );
  const iteratorBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  let iteratorCalls = 0;
  Object.defineProperty(iteratorBagLeaf._zod.bag.patterns, Symbol.iterator, {
    value: function* () {
      iteratorCalls += 1;
      yield iteratorCalls === 1 ? /^https:\/\/example\.com$/ : /.*/;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: iteratorBagLeaf }),
        ),
      }),
    ),
  );
  const constructorBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  constructorBagLeaf._zod.bag.patterns = new Set([/.*/]);
  const corruptedBag = constructorBagLeaf._zod.bag;
  constructorBagLeaf._zod.constr = function CorruptedConstructor() {
    return { _zod: { bag: corruptedBag } };
  };
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: constructorBagLeaf }),
        ),
      }),
    ),
  );
  const shapeLeaf = z.string().regex(/^https:\/\/example\.com$/);
  const shape = { endpoint: shapeLeaf };
  const statefulShapeSchema = z.strictObject(shape);
  let shapeCalls = 0;
  Object.defineProperty(statefulShapeSchema._zod.def, "shape", {
    get: () => {
      shapeCalls += 1;
      if (shapeCalls > 1) shapeLeaf._zod.bag.patterns = new Set([/.*/]);
      return shape;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: statefulShapeSchema })),
  );
  if (shapeCalls !== 0)
    throw new Error("Destination custom shape callback was invoked.");

  const definitionAccessorSchema = materializeRoot(
    z.strictObject({ endpoint: z.string() }),
  );
  const originalType = definitionAccessorSchema._zod.def.type;
  let definitionAccessorCalls = 0;
  Object.defineProperty(definitionAccessorSchema._zod.def, "type", {
    configurable: true,
    enumerable: true,
    get: () => {
      definitionAccessorCalls += 1;
      return originalType;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({ settingsSchema: definitionAccessorSchema }),
    ),
  );
  if (definitionAccessorCalls !== 0)
    throw new Error("Destination definition callback was invoked.");

  const hostileSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(hostileSchema);
  Object.defineProperty(hostileSchema, "safeParse", {
    value: () => Promise.reject(new Error("CANARY_SCHEMA_SECRET")),
  });
  const hostileDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: hostileSchema }),
  );
  expectFixedRejection(() =>
    parseDestinationSettings(hostileDescriptor, { endpoint: 42 }),
  );

  const resolverDescriptor = defineDestinationDescriptor(
    input({
      transport: {
        kind: "remote",
        resolveEndpoint: () =>
          Promise.reject(new Error("CANARY_RESOLVER_SECRET")),
      },
    }),
  );
  expectFixedRejection(() =>
    resolveDestinationConnection(resolverDescriptor, {
      connectionId,
      settings: {},
    }),
  );

  const factoryDescriptor = defineDestinationDescriptor(
    input({
      createReporter: () => Promise.reject(new Error("CANARY_FACTORY_SECRET")),
    }),
  );
  const prepared = resolveDestinationConnection(factoryDescriptor, {
    connectionId,
    settings: {},
  });
  const transport = bindDestinationTransport(prepared.endpoint, async () => ({
    status: 200,
    headers: {},
    body: new Uint8Array(),
  }));
  expectFixedRejection(() =>
    prepareDestinationReporter(prepared, { credentials: {}, transport }),
  );

  await Promise.resolve();
  await Promise.resolve();
  if (unhandled.length !== 0)
    throw new Error("Destination artifact callback rejection leaked.");
} finally {
  process.off("unhandledRejection", collectUnhandled);
}

process.stdout.write("Verified destination callback containment in dist.\n");
