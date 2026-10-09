import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { supplierMavenGoals as mavenGoals } from "../mockserver-material/build-recipe.mjs";
import {
  parseMavenFailureObservation,
  createBuildStderrObservation,
} from "../image-preparation/process-output.mjs";
import {
  lifecycleSourcePins,
  supplierSourceUnit,
  supplierCheckstyleRules,
  firstSupplierCheckstyleObservation,
  patchMockServerLifecycleSource,
} from "../mockserver-material/lifecycle-patch.mjs";

const source = readFileSync(
  new URL("../mockserver-material/lifecycle-patch.mjs", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../mockserver-material/supplier-command.mjs", import.meta.url),
  "utf8",
);
const classifyStyleFailure = runInNewContext(
  `${worker.slice(worker.indexOf("const javacReasons ="), worker.indexOf("const packageFailureStage ="))}\npackageFailureRecord`,
  {
    types,
    mavenGoals,
    Buffer,
    supplierSourceUnit,
    firstSupplierCheckstyleObservation,
    maximumOutputBytes: 8 * 1024 * 1024,
  },
) as (error: unknown) => (string | number)[];
const styleGoal =
  "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-checkstyle-plugin:3.6.0:check (default) on project mockserver-core:";
const styleError = (text: string) =>
  Object.assign(new Error("PRIVATE_CANARY"), {
    stdout: "",
    stderr: text,
    code: 1,
    signal: null,
  });
const classifyStyleConsole = (text: string) =>
  classifyStyleFailure(styleError(`${styleGoal}\n${text}`)).join(",");
// Execute the actual transformations against narrow synthetic preimages. This
// does not authenticate synthetic bytes or execute upstream Java.
const patches = runInNewContext(
  `${source.slice(source.indexOf("const root ="), source.indexOf("export const patchMockServerLifecycleSource")).replaceAll("export const ", "const ")}\npatches`,
) as Record<
  | "eventLog"
  | "persistence"
  | "httpState"
  | "lifeCycle"
  | "jsonBody"
  | "requestHandler"
  | "actionHandler"
  | "logger",
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
const noMatchLog = (
  message: string,
  arguments_: string,
) => `            if (mockServerLogger.isEnabledForInstance(Level.INFO)) {
                mockServerLogger.logEvent(
                    new LogEntry()
                        .setType(NO_MATCH_RESPONSE)
                        .setLogLevel(Level.INFO)
                        .setCorrelationId(request.getLogCorrelationId())
                        .setHttpRequest(request)
                        .setHttpResponse(notFoundResponse())
                        .setMessageFormat(${message})
                        .setArguments(${arguments_})
                );
            }`;
const statusResponse =
  '                    responseWriter.writeResponse(request, OK, portBindingSerializer.serialize(portBinding(server.getLocalPorts())), "application/json");';
const noMatchBranches = [
  noMatchLog(
    "NO_MATCH_RESPONSE_ERROR_MESSAGE_FORMAT",
    "error, request, notFoundResponse()",
  ),
  noMatchLog(
    "NO_MATCH_RESPONSE_NO_EXPECTATION_MESSAGE_FORMAT",
    "request, notFoundResponse()",
  ),
];
const loggerSource = `        if (logEntry.getType() == RECEIVED_REQUEST
            || logEntry.getType() == FORWARDED_REQUEST
            || logEntry.getType() == EXPECTATION_RESPONSE
            || logEntry.isAlwaysLog()
            || isEnabledForInstance(logEntry.getLogLevel())) {
            retain(logEntry);
        }
        if (isEnabledForInstance(logEntry.getLogLevel())) {
            console(logEntry);
        }`;
describe("pinned upstream unmatched-response evidence transformations", () => {
  it("retains both normal and error no-match responses without changing their wire records", () => {
    const input = noMatchBranches.join("\n");
    const output = patches.actionHandler(input);
    const expected = noMatchBranches
      .map((branch) =>
        branch
          .split("\n")
          .slice(1, -1)
          .map((line) => line.slice(4))
          .join("\n"),
      )
      .join("\n");
    expect(output).toBe(expected);
    expect(output).not.toContain("isEnabledForInstance");
    for (const branch of noMatchBranches) {
      expect(() => patches.actionHandler(input.replace(branch, ""))).toThrow();
      expect(() => patches.actionHandler(`${input}\n${branch}`)).toThrow();
      expect(() =>
        patches.actionHandler(
          input.replace(
            branch,
            branch.replace("notFoundResponse()", "changedResponse()"),
          ),
        ),
      ).toThrow();
    }
  });
  it("admits no-match evidence at WARN while keeping console output suppressed", () => {
    const output = patches.logger(loggerSource);
    expect(output).toBe(
      loggerSource.replace(
        "            || logEntry.getType() == EXPECTATION_RESPONSE",
        "            || logEntry.getType() == EXPECTATION_RESPONSE\n            || logEntry.getType() == NO_MATCH_RESPONSE",
      ),
    );
    const condition = output.slice(
      output.indexOf("if (") + 4,
      output.indexOf(") {"),
    );
    for (const type of [
      "RECEIVED_REQUEST",
      "FORWARDED_REQUEST",
      "EXPECTATION_RESPONSE",
      "NO_MATCH_RESPONSE",
      "SERVER_CONFIGURATION",
    ]) {
      const context = {
        RECEIVED_REQUEST: "RECEIVED_REQUEST",
        FORWARDED_REQUEST: "FORWARDED_REQUEST",
        EXPECTATION_RESPONSE: "EXPECTATION_RESPONSE",
        NO_MATCH_RESPONSE: "NO_MATCH_RESPONSE",
        logEntry: {
          getType: () => type,
          isAlwaysLog: () => false,
          getLogLevel: () => "INFO",
        },
        isEnabledForInstance: () => false,
      };
      expect(runInNewContext(condition, context)).toBe(
        type !== "SERVER_CONFIGURATION",
      );
      expect(
        runInNewContext(
          "isEnabledForInstance(logEntry.getLogLevel())",
          context,
        ),
      ).toBe(false);
    }
    expect(() =>
      patches.logger(loggerSource.replace("EXPECTATION_RESPONSE", "CHANGED")),
    ).toThrow();
    expect(() => patches.logger(`${loggerSource}\n${loggerSource}`)).toThrow();
  });
  it("closes new source ordinals without expanding the fixed parser beyond eight", () => {
    for (const [file, ordinal] of [
      ["HttpActionHandler.java", 7],
      ["MockServerLogger.java", 8],
    ] as const) {
      expect(supplierSourceUnit(file)).toBe(ordinal);
      expect(
        parseMavenFailureObservation(`identified,2,0,5,${ordinal},1,0,12`)
          ?.unit,
      ).toBe(ordinal);
    }
    expect(
      parseMavenFailureObservation("identified,2,0,5,9,1,0,12"),
    ).toBeUndefined();
  });
});
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
  it("admits only the eight exact source members, never an arbitrary Java preimage", () => {
    expect(lifecycleSourcePins).toHaveLength(8);
    expect(new Set(lifecycleSourcePins.map(({ path }) => path)).size).toBe(8);
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
      statusResponse,
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
    const statusGate =
      "                    if (!httpState.controlPlaneRequestAuthenticated(request, responseWriter)) {\n                        return;\n                    }\n";
    expect(output).toContain(statusGate + statusResponse);
    expect(
      output
        .replace(/^.*recordFinalControlObservation.*\n/gmu, "")
        .replace(statusGate, ""),
    ).toBe(input);
    expect(() =>
      patches.requestHandler(
        input.replace("isInitializationComplete()", "substituted()"),
      ),
    ).toThrow();
    expect(() => patches.requestHandler(`${input}\n${input}`)).toThrow();
  });
});

describe("source-bound Checkstyle failure observations", () => {
  it("pins the authenticated configuration's rule types, not its instance count", () => {
    const configured = [
      "FileTabCharacter",
      "RegexpSingleline",
      "RegexpSingleline",
      "RedundantImport",
      "UnusedImports",
      "CustomImportOrder",
      "PackageName",
      "StaticVariableNameCheck",
      "MemberNameCheck",
      "MethodNameCheck",
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
    ].map((name) => name.replace(/Check$/u, ""));
    expect(supplierCheckstyleRules).toEqual([...new Set(configured)]);
    expect(supplierCheckstyleRules).toHaveLength(21);
    expect(Object.isFrozen(supplierCheckstyleRules)).toBe(true);
  });
  it.each(
    supplierCheckstyleRules.map((rule, index) => [rule, index + 1] as const),
  )("retains only contextual rule ordinal %s", (rule, ordinal) => {
    const tuple = classifyStyleConsole(
      `[ERROR] /PRIVATE_CANARY/HttpState.java:999999:0: PRIVATE_CANARY [${rule}]`,
    );
    expect(tuple).toBe(`identified,2,0,5,3,999999,0,${ordinal}`);
    expect(parseMavenFailureObservation(tuple)).toMatchObject({
      goal: 5,
      unit: 3,
      line: 999999,
      column: 0,
      reason: ordinal,
    });
    const observer = createBuildStderrObservation();
    observer.consume(
      Buffer.from(
        `[agentscope-material:v1 stage=supplier-connected-package-other family=none maven=${tuple}]\n`,
      ),
    );
    expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE_CANARY");
  });
  it.each(
    lifecycleSourcePins.map(
      (pin, index) => [pin.path.split("/").at(-1)!, index + 1] as const,
    ),
  )("preserves the exact known-source lookup for %s", (file, ordinal) => {
    expect(supplierSourceUnit(file)).toBe(ordinal);
    expect(
      firstSupplierCheckstyleObservation(
        `[ERROR] /PRIVATE_CANARY/${file}:1: PRIVATE_CANARY [NeedBraces]`,
      ),
    ).toEqual([ordinal, 1, 0, 12]);
  });
  it("selects first supported observation, not first overall or the complete set", () => {
    const unknown =
      "[ERROR] /PRIVATE_CANARY/Unknown.java:1:1: PRIVATE_CANARY [Unknown]";
    const first =
      "[ERROR] /PRIVATE_CANARY/HttpState.java:2:3: PRIVATE_CANARY [NeedBraces]";
    const later =
      "[ERROR] /PRIVATE_CANARY/LifeCycle.java:4:5: PRIVATE_CANARY [RightCurly]";
    for (const text of [
      `${unknown}\n${first}\n${later}`,
      `${first}\n${first}\n${later}`,
    ])
      expect(
        classifyStyleFailure(styleError(`${text}\n${styleGoal}`)).join(","),
      ).toBe("identified,2,0,5,3,2,3,12");
    expect(
      classifyStyleFailure(styleError(`${unknown}\n${styleGoal}`)).join(","),
    ).toBe("identified,2,0,5,0,0,0,0");
    expect(
      classifyStyleFailure(
        styleError(`${styleGoal}\n${styleGoal}\n${first}`),
      )[0],
    ).toBe("ambiguous");
    expect(classifyStyleFailure(styleError(first))[0]).toBe("absent");
    expect(supplierSourceUnit("Unknown.java")).toBe(0);
  });
  it.each([
    "[ERROR] /private/HttpState.java:0:1: hidden [NeedBraces]",
    "[ERROR] /private/HttpState.java:1000000:1: hidden [NeedBraces]",
    "[ERROR] /private/HttpState.java:1:1000000: hidden [NeedBraces]",
    "[ERROR] /private/HttpState.java:1:-1: hidden [NeedBraces]",
    "[ERROR] /private/HttpState.java:1:1: hidden [Unknown]",
    "[ERROR] /private/HttpState.java:1:1: hidden [NeedBraces] extra",
  ])("refuses malformed/unsupported observation %s", (text) => {
    expect(firstSupplierCheckstyleObservation(text)).toEqual([0, 0, 0, 0]);
    expect(classifyStyleConsole(text)).toBe("identified,2,0,5,0,0,0,0");
  });
  it.each([
    "identified,2,0,5,3,1,0,21",
    "identified,2,0,5,3,1,1,22",
    "identified,2,0,4,3,1,1,21",
    "identified,2,0,4,3,1,0,1",
  ])("binds rule maxima and zero columns to goal 5 only: %s", (tuple) => {
    expect(parseMavenFailureObservation(tuple) !== undefined).toBe(
      tuple.endsWith(",0,21"),
    );
  });
});
describe("actual optional Maven publisher block", () => {
  it.each([
    ["identified,2,0,3,0,0,0,0", true],
    ["ambiguous,2,0,3,0,0,0,0", true],
    ["overflow,0,0,0,0,0,0,0", true],
    ["identified,257,0,3,0,0,0,0", false],
    ["absent,2,0,3,0,0,0,0", false],
    ["identified,2,0,3,0,0,0,0,extra", false],
    ["identified,2,0,3,0,0,0,0\nCANARY", false],
    ["$(exit 8)", false],
    ["identified,2,0,5,3,42,0,21", true],
    ["identified,2,0,5,3,42,1,22", false],
    ["identified,2,0,4,3,42,1,21", false],
    ["identified,2,0,4,3,42,0,1", false],
  ])(
    "actual workflow retains only canonical Maven tuple %s",
    (tuple, valid) => {
      const workflow = parseYaml(
        readFileSync(
          new URL(
            "../../../.github/workflows/integration.yml",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
      };
      const script = workflow.jobs["mockserver-supplier-research"]!.steps.find(
        (step) => step.name === "Project closed research shell observations",
      )!.run!;
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-c", script],
        {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 4096,
          env: {
            OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE:
              "supplier-connected-package-other",
            OBSERVED_UNTRUSTED_BOOTSTRAP_FAILURE_FAMILY: "none",
            OBSERVED_UNTRUSTED_MAVEN_FAILURE: String(tuple),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `untrusted_maven_failure=${valid ? tuple : "unknown"}`,
      );
      expect(result.stdout).not.toContain("CANARY");
    },
  );
});
describe("single upstream received-request capture and closure", () => {
  it("closes the sole publisher, preserves the bounded consumer join, and snapshots every received request before clear", () => {
    const patched = patches.eventLog(eventSource);
    expect(patched).toContain(
      "public synchronized void add(LogEntry logEntry)",
    );
    expect(patched).toContain(
      "if (finalLedgerStopped) {\n            finalLedgerFailure = true;\n            return;\n        }",
    );
    const closed = patched.indexOf(
      "synchronized (this) {\n            finalLedgerStopped = true;\n        }",
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
  it("keeps the actual fixed refusal format content-free and bounded for every boolean tuple", () => {
    const start = source.indexOf("const persistenceCompletion =");
    const end = source.indexOf("const persistence =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const completion = runInNewContext(
      `${source.slice(start, end)}; persistenceCompletion`,
    ) as string;
    const helper = completion.slice(
      0,
      completion.indexOf("public void completeFinalLedger"),
    );
    const format = helper.match(/System\.err\.printf\("([^"\n]+)"/u)?.[1];
    expect(format).toBe(
      "[agentscope-mockserver-ledger:v1 stage=%s terminal=%b snapshotAvailable=%b persistenceClosed=%b persistenceFailed=%b]\\n",
    );
    expect(helper).not.toMatch(
      /snapshot\.|filePath|throwable|\.getMessage|\.toString/u,
    );
    for (const stage of ["eligibility", "publication"])
      for (let value = 0; value < 16; value++) {
        let index = 0;
        const line = format!
          .replace("%s", stage)
          .replace(/%b/gu, () => String(Boolean(value & (1 << index++))))
          .replace(/\\n$/u, "\n");
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256);
        expect(line).not.toContain("%b");
      }
  });
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
    for (const block of [
      "try {\n                writer.close();\n            } catch (Throwable throwable) {\n                if (firstFailure == null)",
      "if (firstFailure == null) {\n                    firstFailure = throwable;\n                }",
      "if (firstFailure != null) {\n                throw firstFailure;\n            }",
    ])
      expect(patched).toContain(block);
    expect(patched).not.toMatch(/\{[^\n{}]*\S[^\n{}]*\}/u);
    expect(patched).toContain(
      "!terminal || recordedPersistenceFailed || !recordedPersistenceClosed || snapshot == null",
    );
    expect(patched).toContain('equals("/control/private/requests.json")');
    expect(patched).toContain(
      'equals("/control/private/requests.json")) {\n                observeFinalLedgerRefusal(false, terminal, snapshot != null);\n                return;',
    );
    expect(patched).toContain(
      "if (bytes.length > 1024 * 1024) {\n                observeFinalLedgerRefusal(false, terminal, snapshot != null);\n                return;",
    );
    expect(patched.indexOf("Files.write(filePath")).toBeLessThan(
      patched.indexOf("receipt.write"),
    );
    expect(patched.indexOf("receipt.flush")).toBeLessThan(
      patched.indexOf("Files.move(temporary, complete"),
    );
    expect(patched).toContain("java.nio.file.LinkOption.NOFOLLOW_LINKS");
    expect(patched).toContain("java.nio.file.StandardCopyOption.ATOMIC_MOVE");
    expect(patched).toContain(
      "recordedPersistenceFailed = true;\n            observeFinalLedgerRefusal(true, terminal, snapshot != null);",
    );
    expect(patched).toContain(
      "catch (Throwable ignored) {\n            // Optional fixed observation cannot change persistence or completion.",
    );
    expect(
      patched.match(
        /observeFinalLedgerRefusal\((?:false|true), terminal, snapshot != null\);/gu,
      ),
    ).toHaveLength(3);
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
    expect(state).not.toMatch(/\{[^\n{}]*\S[^\n{}]*\}/u);
    expect(state).toContain(
      "catch (Throwable throwable) {\n            finalControlCaptureFailed = true;\n        }",
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
      "if (remaining > 0) {\n            finalLedgerFailure = true;\n        }",
    );
    expect(lifecycle).toContain(
      "httpState.completeRecordedLedger(!finalLedgerFailure && requestsInFlight.get() == 0);",
    );
    expect(lifecycle.indexOf("httpState.completeRecordedLedger")).toBeLessThan(
      lifecycle.indexOf("stopFuture.complete(message)"),
    );
  });
});
