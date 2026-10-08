/** Pinned stop/capture patch and source-style observations; no control authority. */
import { createHash } from "node:crypto";
import { types } from "node:util";

const root = "mockserver";
export const lifecycleSourcePins = Object.freeze([
  Object.freeze({
    name: "jsonBody",
    path: `${root}/mockserver-core/src/main/java/org/mockserver/serialization/serializers/body/JsonBodySerializer.java`,
    bytes: 4270,
    sha256: "07d52a98c4e54c89084c588b5312926335f05fc8054fc90b336af43be6db6591",
  }),
  Object.freeze({
    name: "eventLog",
    path: `${root}/mockserver-core/src/main/java/org/mockserver/log/MockServerEventLog.java`,
    bytes: 101942,
    sha256: "61b3ad7dcfd16d547542a12516aeb14cf08b431b3b4ba79121dc62e986a94e1d",
  }),
  Object.freeze({
    name: "httpState",
    path: `${root}/mockserver-core/src/main/java/org/mockserver/mock/HttpState.java`,
    bytes: 474129,
    sha256: "0a67190f4417a7223b7dcb9a49f88bd66bf1ca2913dab9791a96fc6b0ffe25e3",
  }),
  Object.freeze({
    name: "persistence",
    path: `${root}/mockserver-core/src/main/java/org/mockserver/persistence/RecordedRequestsFileSystemPersistence.java`,
    bytes: 6900,
    sha256: "4e6a448f9942826f68db142b5ff154f861e2f55dc4113c6e359ef781d97929cd",
  }),
  Object.freeze({
    name: "lifeCycle",
    path: `${root}/mockserver-netty/src/main/java/org/mockserver/lifecycle/LifeCycle.java`,
    bytes: 41382,
    sha256: "1b9983604701707089fdd6dffc0e66e37ecbb9ae7fa79c04e15605943b685dbf",
  }),
  Object.freeze({
    name: "requestHandler",
    path: `${root}/mockserver-netty/src/main/java/org/mockserver/netty/HttpRequestHandler.java`,
    bytes: 53826,
    sha256: "f8953a1c8405fe31d9956e47dc9f9fe4efefbf9dc1d449ebbb83ad9ff1d4e7a6",
  }),
]);
// Pinned checkstyle.xml rule types, not configured instance counts. The two
// RegexpSingleline instances share one type ordinal; messages never escape.
export const supplierCheckstyleRules = Object.freeze([
  "FileTabCharacter",
  "RegexpSingleline",
  "RedundantImport",
  "UnusedImports",
  "CustomImportOrder",
  "PackageName",
  "StaticVariableName",
  "MemberName",
  "MethodName",
  "LeftCurly",
  "RightCurly",
  "NeedBraces",
  "UpperEll",
  "EmptyCatchBlock",
  "RegexpSinglelineJava",
  "FallThrough",
  "WhitespaceAround",
  "WhitespaceAfter",
  "NoWhitespaceAfter",
  "NoWhitespaceBefore",
  "ParenPad",
]);
export const supplierSourceUnit = (file) =>
  lifecycleSourcePins.findIndex((pin) => pin.path.endsWith(`/${file}`)) + 1;
/** First supported observation, not first overall or an exhaustive violation set. */
export const firstSupplierCheckstyleObservation = (text) => {
  for (const match of text.matchAll(
    /^(?:\[INFO\] )?\[ERROR\] \/[^\r\n]*\/([A-Za-z]+\.java):([1-9][0-9]{0,5})(?::(0|[1-9][0-9]{0,5}))?: [^\r\n]* \[([A-Za-z]+)\]$/gmu,
  )) {
    const [, file, line, column, rule] = match;
    const unit = supplierSourceUnit(file);
    const reason = supplierCheckstyleRules.indexOf(rule) + 1;
    if (unit && reason && Number(line) > 0)
      return Object.freeze([unit, Number(line), Number(column ?? 0), reason]);
  }
  return Object.freeze([0, 0, 0, 0]);
};
const fail = () => {
  throw new Error("integration.mockserver-material.lifecycle-preimage");
};
const once = (source, before, after) => {
  const offset = source.indexOf(before);
  if (offset < 0 || source.indexOf(before, offset + before.length) >= 0) fail();
  return source.slice(0, offset) + after + source.slice(offset + before.length);
};
const finalLedgerCapture = `
    public void recordFinalControlObservation(HttpRequest request, String role, int status) {
        try {
            if (!java.util.Set.of("allowed", "forbidden", "unauthenticated", "readiness").contains(role)
                || status < 100 || status > 599) {
                throw new IllegalStateException();
            }
            byte[] body = request.getBodyAsOriginalRawBytes();
            if (body == null || body.length > 1024 * 1024) {
                throw new IllegalStateException();
            }
            HttpRequest observed = new HttpRequest().withMethod(request.getMethod().getValue()).withPath(request.getPath().getValue())
                .withHeader("x-agentscope-final-role", role)
                .withHeader("x-agentscope-final-status", String.valueOf(status))
                .withHeader("x-agentscope-final-bytes", String.valueOf(body.length))
                .withHeader("x-agentscope-final-sha256", java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(body)));
            // The fresh request has no caller headers, body, JWT or authorization material.
            add(new LogEntry().setType(RECEIVED_REQUEST).setLogLevel(org.slf4j.event.Level.INFO).setHttpRequest(observed)
                .setMessageFormat("agentscope-final-control"));
        } catch (Throwable throwable) {
            finalLedgerFailure = true;
        }
    }

    private RequestDefinition finalLedgerRequest(LogEntry received) {
        if (!(received.getHttpRequest() instanceof HttpRequest)) {
            throw new IllegalStateException();
        }
        HttpRequest request = (HttpRequest) received.getHttpRequest();
        if ("agentscope-final-control".equals(received.getMessageFormat())) {
            return request;
        }
        String correlation = received.getCorrelationId();
        if (correlation == null || correlation.isEmpty()) {
            throw new IllegalStateException();
        }
        List<LogEntry> responses = eventLog.stream().filter(requestResponseLogPredicate)
            .filter(entry -> correlation.equals(entry.getCorrelationId())).collect(Collectors.toList());
        if (responses.size() != 1 || responses.get(0).getHttpResponse() == null) {
            throw new IllegalStateException();
        }
        Integer status = responses.get(0).getHttpResponse().getStatusCode();
        if (status == null || status < 100 || status > 599) {
            throw new IllegalStateException();
        }
        return request.clone().withBody(request.getBodyAsOriginalRawBytes())
            .withHeader("x-agentscope-final-role", "data-plane")
            .withHeader("x-agentscope-final-status", String.valueOf(status));
    }
`;
const eventLog = (source) => {
  source = once(
    source,
    "    private Consumer<LogEntry> recordedRequestConsumer;",
    `    private Consumer<LogEntry> recordedRequestConsumer;
    private volatile boolean finalLedgerFailure;
    private boolean finalLedgerStopped;
    private volatile String finalRecordedRequests;

    public String finalRecordedRequests() {
        return finalLedgerFailure ? null : finalRecordedRequests;
    }
${finalLedgerCapture}`,
  );
  source = once(
    source,
    "    public void add(LogEntry logEntry) {",
    `    public synchronized void add(LogEntry logEntry) {
        if (finalLedgerStopped) {
            finalLedgerFailure = true;
            return;
        }`,
  );
  source = once(
    source,
    "    public void stop() {\n        try {",
    `    public void stop() {
        // Close the existing publisher before joining its consumer. A publisher
        // already inside add finishes before this flag; later publication fails closed.
        synchronized (this) {
            finalLedgerStopped = true;
        }
        try {`,
  );
  source = once(
    source,
    "        if (isLoadGenerated(logEntry)) {",
    "        if (isLoadGenerated(logEntry)) {\n            finalLedgerFailure = true;",
  );
  for (const before of [
    "                droppedLogEvents.incrementAndGet();",
    '                logger.error("exception handling log entry in log ring buffer, for log entry: " + logEntry, ex);',
    '                logger.error("exception starting log ring buffer", ex);',
    '                logger.error("exception during shutdown of log ring buffer", ex);',
  ])
    source = once(
      source,
      before,
      "            finalLedgerFailure = true;\n" + before,
    );
  source = once(
    source,
    "        if (eventLog.getEvictedCount() > 0 && evictedLogEntryWarned.compareAndSet(false, true)) {",
    "        if (eventLog.getEvictedCount() > 0 && evictedLogEntryWarned.compareAndSet(false, true)) {\n            finalLedgerFailure = true;",
  );
  for (const before of [
    "            if (body != null && body.length > maxLoggedBodyBytes) {",
  ]) {
    const count = source.split(before).length - 1;
    if (count !== 2) fail();
    source = source
      .split(before)
      .join(before + "\n                finalLedgerFailure = true;");
  }
  source = once(
    source,
    "            eventLog.clear();\n            disruptor.shutdown(2, SECONDS);",
    `            // The existing bounded shutdown drains and joins the sole consumer.
            // Snapshot ALL received requests, including unmatched traffic, before clear.
            disruptor.shutdown(2, SECONDS);
            if (!finalLedgerFailure && droppedLogEvents.get() == 0 && eventLog.getEvictedCount() == 0) {
                List<RequestDefinition> requests = eventLog.stream()
                    .filter(entry -> entry.getType() == RECEIVED_REQUEST)
                    .map(this::finalLedgerRequest).collect(Collectors.toList());
                if (requests.size() > 16) {
                    finalLedgerFailure = true;
                } else {
                    finalRecordedRequests = requestDefinitionSerializer.serializeRecordedRequests(false, requests);
                }
            }
            eventLog.clear();`,
  );
  source = once(
    source,
    "            if (!(throwable instanceof com.lmax.disruptor.TimeoutException)) {",
    "            finalLedgerFailure = true;\n            if (!(throwable instanceof com.lmax.disruptor.TimeoutException)) {",
  );
  source = once(
    source,
    "    public void reset() {",
    "    public void reset() {\n        finalLedgerFailure = true;",
  );
  return once(
    source,
    "    public void clear(RequestDefinition requestDefinition) {",
    "    public void clear(RequestDefinition requestDefinition) {\n        finalLedgerFailure = true;",
  );
};
const persistenceCompletion = `
    public void completeFinalLedger(String snapshot, boolean terminal) {
        writeOrderLock.lock();
        try {
            if (!terminal || recordedPersistenceFailed || !recordedPersistenceClosed || snapshot == null
                || filePath == null || !filePath.toString().equals("/control/private/requests.json")) {
                return;
            }
            byte[] bytes = (snapshot + "\\n").getBytes(UTF_8);
            if (bytes.length > 1024 * 1024) {
                return;
            }
            Path complete = filePath.resolveSibling("requests.complete");
            Path temporary = filePath.resolveSibling("requests.complete.tmp");
            // Both final snapshot and receipt writers close before the receipt is published.
            Files.write(filePath, bytes, java.nio.file.StandardOpenOption.WRITE,
                java.nio.file.StandardOpenOption.TRUNCATE_EXISTING, java.nio.file.LinkOption.NOFOLLOW_LINKS);
            try (Writer receipt = Files.newBufferedWriter(temporary, UTF_8,
                java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE,
                java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                receipt.write("complete\\n");
                receipt.flush();
            }
            Files.move(temporary, complete, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (Throwable throwable) {
            recordedPersistenceFailed = true;
        } finally {
            writeOrderLock.unlock();
        }
    }
`;
const persistence = (source) => {
  source = once(
    source,
    "    private final Writer writer;",
    "    private final Writer writer;\n    private volatile boolean recordedPersistenceFailed;\n    private volatile boolean recordedPersistenceClosed;",
  );
  if (source.split("catch (Throwable throwable) {").length - 1 !== 3) fail();
  source = source
    .split("catch (Throwable throwable) {")
    .join(
      "catch (Throwable throwable) {\n            recordedPersistenceFailed = true;",
    );
  source = once(
    source,
    "        writeOrderLock.lock();\n        try {\n            // use the redaction-aware",
    "        writeOrderLock.lock();\n        try {\n            if (recordedPersistenceClosed) {\n                recordedPersistenceFailed = true;\n                return;\n            }\n            // use the redaction-aware",
  );
  source = once(
    source,
    "            writer.flush();\n            writer.close();",
    `            Throwable firstFailure = null;
            try {
                writer.flush();
            } catch (Throwable throwable) {
                firstFailure = throwable;
            }
            try {
                writer.close();
            } catch (Throwable throwable) {
                if (firstFailure == null) {
                    firstFailure = throwable;
                }
            }
            if (firstFailure != null) {
                throw firstFailure;
            }
            recordedPersistenceClosed = true;`,
  );
  return once(
    source,
    "    public void stop() {",
    persistenceCompletion + "\n    public void stop() {",
  );
};
const httpState = (source) => {
  const before =
    "        if (recordedRequestsFileSystemPersistence != null) {\n            recordedRequestsFileSystemPersistence.stop();\n        }\n";
  source = once(source, before, "");
  source = once(
    source,
    "        getMockServerLog().stop();",
    "        getMockServerLog().stop();\n" + before,
  );
  source = once(
    source,
    "    public void stop() {",
    `    private volatile boolean finalControlCaptureFailed;

    public void recordFinalControlObservation(HttpRequest request, String role, int status) {
        try {
            getMockServerLog().recordFinalControlObservation(request, role, status);
        } catch (Throwable throwable) {
            finalControlCaptureFailed = true;
        }
    }

    private ControlPlaneAuthDecision finalControlDecision(HttpRequest request, ControlPlaneAuthDecision decision) {
        try {
            String role = decision.isAllowed() ? "allowed"
                : decision.outcome() == ControlPlaneAuthOutcome.FORBIDDEN ? "forbidden" : "unauthenticated";
            int status = decision.isAllowed()
                ? request.getPath().getValue().equals("/_mockserver_callback_websocket") ? 101
                    : request.getPath().getValue().equals("/mockserver/expectation") ? 201 : 200
                : decision.outcome() == ControlPlaneAuthOutcome.FORBIDDEN ? 403 : 401;
            recordFinalControlObservation(request, role, status);
        } catch (Throwable throwable) {
            finalControlCaptureFailed = true;
        }
        return decision;
    }

    public void completeRecordedLedger(boolean terminal) {
        if (recordedRequestsFileSystemPersistence != null) {
            recordedRequestsFileSystemPersistence.completeFinalLedger(
                getMockServerLog().finalRecordedRequests(), terminal && !finalControlCaptureFailed);
        }
    }

    public void stop() {`,
  );
  for (const expression of [
    "ControlPlaneAuthDecision.FORBIDDEN",
    "ControlPlaneAuthDecision.ALLOWED",
    "new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, authenticationException.getMessage())",
  ])
    source = once(
      source,
      `return ${expression};`,
      `return finalControlDecision(request, ${expression});`,
    );
  const unauthenticated =
    "return new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, null);";
  if (source.split(unauthenticated).length - 1 !== 2) fail();
  return source
    .split(unauthenticated)
    .join(
      "return finalControlDecision(request, new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, null));",
    );
};
const lifeCycle = (source) => {
  source = once(
    source,
    "    public void requestProcessingStarted() {",
    "    private volatile boolean finalLedgerFailure;\n\n    public void requestProcessingStarted() {",
  );
  for (const before of [
    "                            // best-effort cleanup during shutdown - log and continue",
    "                    // best-effort cleanup during shutdown - log and continue",
  ])
    source = once(
      source,
      "\n" + before,
      "\n                    finalLedgerFailure = true;\n" + before,
    );
  source = once(
    source,
    "        int remaining = requestsInFlight.get();",
    "        int remaining = requestsInFlight.get();\n        if (remaining > 0) {\n            finalLedgerFailure = true;\n        }",
  );
  return once(
    source,
    "                stopFuture.complete(message);",
    "                httpState.completeRecordedLedger(!finalLedgerFailure && requestsInFlight.get() == 0);\n                stopFuture.complete(message);",
  );
};
const jsonBody = (source) =>
  once(
    once(source, "import java.util.Arrays;\n", ""),
    "            && jsonBody.getRawBytes() != null\n            && !Arrays.equals(jsonBody.getRawBytes(), OBJECT_MAPPER.writeValueAsBytes(jsonNode));",
    "            && jsonBody.getRawBytes() != null;",
  );
const requestHandler = (source) => {
  for (const [condition, status] of [
    ["                    if (httpState.isInitializationComplete()) {", 200],
    [
      '                    } else {\n                        responseWriter.writeResponse(request, SERVICE_UNAVAILABLE, "{\\"status\\":\\"NOT_READY\\"}", "application/json");',
      503,
    ],
  ]) {
    const replacement =
      status === 200
        ? `${condition}\n                        httpState.recordFinalControlObservation(request, "readiness", 200);`
        : condition.replace(
            "                        responseWriter.writeResponse",
            '                        httpState.recordFinalControlObservation(request, "readiness", 503);\n                        responseWriter.writeResponse',
          );
    source = once(source, condition, replacement);
  }
  return source;
};
const patches = Object.freeze({
  eventLog,
  persistence,
  httpState,
  lifeCycle,
  jsonBody,
  requestHandler,
});
export const patchMockServerLifecycleSource = (name, input) => {
  const pin = lifecycleSourcePins.find((entry) => entry.name === name);
  if (pin === undefined || !types.isUint8Array(input)) fail();
  const bytes = Buffer.copyBytesFrom(input, 0, pin.bytes + 1);
  if (
    bytes.length !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    fail();
  return patches[pin.name](bytes.toString("utf8"));
};
