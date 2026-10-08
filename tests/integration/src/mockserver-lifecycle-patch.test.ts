import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  lifecycleSourcePins,
  patchMockServerLifecycleSource,
} from "../mockserver-material/lifecycle-patch.mjs";

const source = readFileSync(
  new URL("../mockserver-material/lifecycle-patch.mjs", import.meta.url),
  "utf8",
);
// Execute the actual transformations against narrow synthetic preimages. This
// does not authenticate synthetic bytes or execute upstream Java.
const patches = runInNewContext(
  `${source.slice(source.indexOf("const root ="), source.indexOf("export const patchMockServerLifecycleSource")).replace("export const lifecycleSourcePins", "const lifecycleSourcePins")}\npatches`,
) as Record<
  | "eventLog"
  | "persistence"
  | "httpState"
  | "lifeCycle"
  | "jsonBody"
  | "requestHandler",
  (value: string) => string
>;
const eventSource = [
  "    private Consumer<LogEntry> recordedRequestConsumer;",
  "    public void add(LogEntry logEntry) {",
  "        if (isLoadGenerated(logEntry)) {",
  "                droppedLogEvents.incrementAndGet();",
  '                logger.error("exception handling log entry in log ring buffer, for log entry: " + logEntry, ex);',
  '                logger.error("exception starting log ring buffer", ex);',
  '                logger.error("exception during shutdown of log ring buffer", ex);',
  "        if (eventLog.getEvictedCount() > 0 && evictedLogEntryWarned.compareAndSet(false, true)) {",
  "            if (body != null && body.length > maxLoggedBodyBytes) {",
  "            if (body != null && body.length > maxLoggedBodyBytes) {",
  "    public void stop() {\n        try {",
  "            eventLog.clear();\n            disruptor.shutdown(2, SECONDS);",
  "            if (!(throwable instanceof com.lmax.disruptor.TimeoutException)) {",
  "    public void reset() {",
  "    public void clear(RequestDefinition requestDefinition) {",
].join("\n");
const authenticationSource = [
  "return ControlPlaneAuthDecision.FORBIDDEN;",
  "return ControlPlaneAuthDecision.ALLOWED;",
  "return new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, authenticationException.getMessage());",
  "return new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, null);",
  "return new ControlPlaneAuthDecision(ControlPlaneAuthOutcome.UNAUTHENTICATED, null);",
].join("\n");
describe("pinned upstream final-ledger lifecycle transformations", () => {
  it("retains exact raw bytes only on the existing recorded-request serializer path", () => {
    const source =
      'import java.util.Arrays;\nboolean rawBytesNonDefault = Boolean.TRUE.equals(provider.getAttribute("emitRawBytes"))\n            && jsonBody.getRawBytes() != null\n            && !Arrays.equals(jsonBody.getRawBytes(), OBJECT_MAPPER.writeValueAsBytes(jsonNode));';
    const patched = patches.jsonBody(source);
    expect(patched).toBe(
      'boolean rawBytesNonDefault = Boolean.TRUE.equals(provider.getAttribute("emitRawBytes"))\n            && jsonBody.getRawBytes() != null;',
    );
    for (const raw of ['{"input":"one"}', '{ "input" : "one" }']) {
      const bytes = Buffer.from(raw);
      for (const enabled of [false, true]) {
        for (const held of [null, bytes]) {
          const recordsRaw = runInNewContext(
            patched.slice(patched.indexOf(" = ") + 3, -1),
            {
              Boolean: { TRUE: { equals: (value: unknown) => value === true } },
              provider: {
                getAttribute: (name: string) =>
                  name === "emitRawBytes" && enabled,
              },
              jsonBody: { getRawBytes: () => held },
            },
          ) as boolean;
          expect(recordsRaw).toBe(enabled && held !== null);
          if (recordsRaw)
            expect(Buffer.from(bytes.toString("base64"), "base64")).toEqual(
              bytes,
            );
        }
      }
    }
    expect(() =>
      patches.jsonBody(source.replace(" != null", " == null")),
    ).toThrow();
    expect(() => patches.jsonBody(`${source}\n${source}`)).toThrow();
    expect(patched).not.toContain("import java.util.Arrays;");
    expect(() =>
      patches.jsonBody(source.replace("import java.util.Arrays;\n", "")),
    ).toThrow();
    expect(() =>
      patches.jsonBody(`import java.util.Arrays;\n${source}`),
    ).toThrow();
  });
  it("admits only the six exact source members, never an arbitrary Java preimage", () => {
    expect(lifecycleSourcePins).toHaveLength(6);
    expect(new Set(lifecycleSourcePins.map(({ path }) => path)).size).toBe(6);
    for (const pin of lifecycleSourcePins) {
      expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(() =>
        patchMockServerLifecycleSource(pin.name, Buffer.alloc(pin.bytes)),
      ).toThrow("integration.mockserver-material.lifecycle-preimage");
      expect(() =>
        patchMockServerLifecycleSource(pin.name, Buffer.alloc(pin.bytes + 1)),
      ).toThrow();
    }
    expect(() =>
      patchMockServerLifecycleSource("caller-label", Buffer.from("CANARY")),
    ).toThrow();
  });
  it("records the chosen readiness status before the unchanged upstream response branch", () => {
    const input = [
      "                    if (httpState.isInitializationComplete()) {",
      '                        responseWriter.writeResponse(request, OK, "{\\"status\\":\\"READY\\"}", "application/json");',
      "                    } else {",
      '                        responseWriter.writeResponse(request, SERVICE_UNAVAILABLE, "{\\"status\\":\\"NOT_READY\\"}", "application/json");',
      "                    }",
    ].join("\n");
    const output = patches.requestHandler(input);
    for (const [status, response] of [
      [200, "OK"],
      [503, "SERVICE_UNAVAILABLE"],
    ] as const) {
      const observed = output.indexOf(
        `recordFinalControlObservation(request, "readiness", ${status})`,
      );
      const written = output.indexOf(
        `responseWriter.writeResponse(request, ${response},`,
      );
      expect(observed).toBeGreaterThan(-1);
      expect(written).toBeGreaterThan(observed);
    }
    expect(output.replace(/^.*recordFinalControlObservation.*\n/gmu, "")).toBe(
      input,
    );
    expect(() =>
      patches.requestHandler(
        input.replace("isInitializationComplete()", "substituted()"),
      ),
    ).toThrow();
    expect(() => patches.requestHandler(`${input}\n${input}`)).toThrow();
  });
});
describe("single upstream received-request capture and closure", () => {
  it("closes the sole publisher, preserves the bounded consumer join, and snapshots every received request before clear", () => {
    const patched = patches.eventLog(eventSource);
    expect(patched).toContain(
      "public synchronized void add(LogEntry logEntry)",
    );
    expect(patched).toContain(
      "if (finalLedgerStopped) { finalLedgerFailure = true; return; }",
    );
    const closed = patched.indexOf(
      "synchronized (this) { finalLedgerStopped = true; }",
    );
    const joined = patched.indexOf("disruptor.shutdown(2, SECONDS)");
    const snapshot = patched.indexOf(
      "serializeRecordedRequests(false, requests)",
    );
    const cleared = patched.indexOf("eventLog.clear()");
    expect(closed).toBeGreaterThan(-1);
    expect(joined).toBeGreaterThan(closed);
    expect(snapshot).toBeGreaterThan(joined);
    expect(cleared).toBeGreaterThan(snapshot);
    expect(patched).toContain(
      ".filter(entry -> entry.getType() == RECEIVED_REQUEST)",
    );
    expect(patched).not.toContain("requestLogPredicate");
    expect(patched.match(/finalLedgerFailure = true;/gu)).toHaveLength(14);
    expect(patched).toContain(
      "droppedLogEvents.get() == 0 && eventLog.getEvictedCount() == 0",
    );
  });
  it("captures only fresh minimal control rows and refuses unpaired, duplicate or overflow traffic", () => {
    const patched = patches.eventLog(eventSource);
    expect(patched).toContain(
      "new HttpRequest().withMethod(request.getMethod().getValue()).withPath(request.getPath().getValue())",
    );
    expect(patched).toContain("request.getBodyAsOriginalRawBytes()");
    expect(patched).toContain(
      'java.security.MessageDigest.getInstance("SHA-256").digest(body)',
    );
    for (const field of ["role", "status", "bytes", "sha256"])
      expect(patched).toContain(`"x-agentscope-final-${field}"`);
    expect(patched).not.toContain("request.getHeaders()");
    expect(patched).not.toContain(".withBody(body)");
    expect(patched).toContain("correlation.equals(entry.getCorrelationId())");
    expect(patched).toContain("responses.size() != 1");
    expect(patched).toContain("responses.get(0).getHttpResponse() == null");
    expect(patched).toContain(
      "request.clone().withBody(request.getBodyAsOriginalRawBytes())",
    );
    expect(patched).toContain("requests.size() > 16");
    expect(patched).toContain(".map(this::finalLedgerRequest)");
    for (const guard of [
      "|| status < 100 || status > 599) {",
      "if (body == null || body.length > 1024 * 1024) {",
      "if (!(received.getHttpRequest() instanceof HttpRequest)) {",
      'if ("agentscope-final-control".equals(received.getMessageFormat())) {',
      "if (correlation == null || correlation.isEmpty()) {",
      "if (responses.size() != 1 || responses.get(0).getHttpResponse() == null) {",
      "if (status == null || status < 100 || status > 599) {",
      "if (requests.size() > 16) {",
    ]) {
      expect(patched).toContain(guard);
    }
    expect(patched).toContain(
      "} else {\n                    finalRecordedRequests =",
    );
  });
  it("refuses missing or duplicated exact transformation anchors", () => {
    expect(() =>
      patches.eventLog(
        eventSource.replace("    public void reset() {", "missing"),
      ),
    ).toThrow();
    expect(() =>
      patches.eventLog(eventSource + "\n    public void reset() {"),
    ).toThrow();
  });
});
describe("terminal persistence and existing stop barrier", () => {
  it("always closes persistence, preserves first failure, and publishes a fixed receipt only after snapshot and receipt close", () => {
    const input = [
      "    private final Writer writer;",
      "catch (Throwable throwable) {",
      "catch (Throwable throwable) {",
      "catch (Throwable throwable) {",
      "        writeOrderLock.lock();\n        try {\n            // use the redaction-aware",
      "            writer.flush();\n            writer.close();",
      "    public void stop() {",
    ].join("\n");
    const patched = patches.persistence(input);
    expect(patched).toContain(
      "try { writer.close(); } catch (Throwable throwable) {\n                if (firstFailure == null)",
    );
    expect(patched).toContain(
      "if (firstFailure == null) {\n                    firstFailure = throwable;\n                }",
    );
    expect(patched).toContain(
      "if (firstFailure != null) { throw firstFailure; }",
    );
    expect(patched).toContain(
      "!terminal || recordedPersistenceFailed || !recordedPersistenceClosed || snapshot == null",
    );
    expect(patched).toContain('equals("/control/private/requests.json")');
    expect(patched).toContain(
      'equals("/control/private/requests.json")) {\n                return;',
    );
    expect(patched).toContain(
      "if (bytes.length > 1024 * 1024) {\n                return;",
    );
    expect(patched.indexOf("Files.write(filePath")).toBeLessThan(
      patched.indexOf("receipt.write"),
    );
    expect(patched.indexOf("receipt.flush")).toBeLessThan(
      patched.indexOf("Files.move(temporary, complete"),
    );
    expect(patched).toContain("java.nio.file.LinkOption.NOFOLLOW_LINKS");
    expect(patched).toContain("java.nio.file.StandardCopyOption.ATOMIC_MOVE");
  });
  it("moves persistence close after log drain and accepts finality only after original lifecycle joins", () => {
    const state = patches.httpState(
      "        if (recordedRequestsFileSystemPersistence != null) {\n            recordedRequestsFileSystemPersistence.stop();\n        }\n        getMockServerLog().stop();\n    public void stop() {\n" +
        authenticationSource,
    );
    expect(state.indexOf("getMockServerLog().stop()")).toBeLessThan(
      state.indexOf("recordedRequestsFileSystemPersistence.stop()"),
    );
    expect(state).toContain("terminal && !finalControlCaptureFailed");
    expect(state.match(/return finalControlDecision\(request,/gu)).toHaveLength(
      5,
    );
    expect(state).toContain("return decision;");
    expect(state).toContain(
      "catch (Throwable throwable) { finalControlCaptureFailed = true; }",
    );
    for (const original of authenticationSource.split("\n"))
      expect(state).not.toContain(original);
    const lifecycle = patches.lifeCycle(
      [
        "    public void requestProcessingStarted() {",
        "                            // best-effort cleanup during shutdown - log and continue",
        "                    // best-effort cleanup during shutdown - log and continue",
        "        int remaining = requestsInFlight.get();",
        "                stopFuture.complete(message);",
      ].join("\n"),
    );
    expect(lifecycle).toContain(
      "if (remaining > 0) { finalLedgerFailure = true; }",
    );
    expect(lifecycle).toContain(
      "httpState.completeRecordedLedger(!finalLedgerFailure && requestsInFlight.get() == 0);",
    );
    expect(lifecycle.indexOf("httpState.completeRecordedLedger")).toBeLessThan(
      lifecycle.indexOf("stopFuture.complete(message)"),
    );
  });
});
