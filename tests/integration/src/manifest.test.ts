import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createMockServerInitialization,
  MODEL_PROTOCOL_ROUTES,
} from "@agentscope/testkit";

import {
  capabilityScenarioImages,
  capabilityManifestIdentity,
  compileInteractivePtyActions,
  compileCapabilityManifest,
  partitionCapabilityScenarios,
  selectCapabilityScenarios,
  verifyManifestEvidence,
  type CapabilityManifest,
} from "./manifest.js";

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestFixture = (): CapabilityManifest =>
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ) as CapabilityManifest;

const withIdentity = (
  value: Omit<CapabilityManifest, "manifestIdentity">,
): CapabilityManifest => ({
  ...value,
  manifestIdentity: capabilityManifestIdentity(value),
});

// eslint-disable-next-line max-lines-per-function -- closed manifest boundary matrix
describe("integration capability manifest", () => {
  it("compiles the committed manifest and verifies descriptor evidence", () => {
    const compiled = compileCapabilityManifest(manifestFixture());
    verifyManifestEvidence(compiled, integrationRoot);
    expect(compiled.manifestIdentity).toMatch(/^sha256-[a-f\d]{64}$/u);
    expect(Object.isFrozen(compiled.scenarios[0])).toBe(true);
    const codex = compiled.evidence.find(
      ({ evidenceId }) => evidenceId === "codex-0-149-1",
    );
    expect(codex?.material.kind).toBe("npm");
    expect(codex?.admission).toBeUndefined();
  });

  it("keeps authenticated diagnostic material distinct from support admission", () => {
    const original = manifestFixture();
    const codex = original.evidence.find(
      ({ evidenceId }) => evidenceId === "codex-0-149-1",
    )!;
    expect(codex.material.kind).toBe("npm");
    expect(codex.admission).toBeUndefined();

    const fixture = original.evidence.find(
      ({ evidenceId }) => evidenceId === "fixture-process-v1",
    )!;
    expect(() =>
      compileCapabilityManifest(
        withIdentity({
          ...original,
          evidence: [{ ...fixture, admission: {} as never }],
          requiredRepresentativeIds: [fixture.evidenceId],
          scenarios: original.scenarios.filter(
            ({ harnessEvidenceId }) => harnessEvidenceId === fixture.evidenceId,
          ),
        }),
      ),
    ).toThrow("integration.manifest.invalid");
  });

  it("rejects identity, duplicate, reference, and coverage drift", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        manifestIdentity: "sha256-" + "0".repeat(64),
      }),
    ).toThrow("integration.manifest.identity");
    for (const mutated of [
      withIdentity({
        ...original,
        evidence: [...original.evidence, original.evidence[0]!],
      }),
      withIdentity({
        ...original,
        scenarios: [...original.scenarios, original.scenarios[0]!],
      }),
      withIdentity({
        ...original,
        requiredRepresentativeIds: ["uncovered-evidence"],
      }),
      withIdentity({
        ...original,
        scenarios: [
          { ...original.scenarios[0]!, harnessEvidenceId: "unknown-evidence" },
        ],
      }),
    ])
      expect(() => compileCapabilityManifest(mutated)).toThrow(
        /integration\.manifest/u,
      );
  });

  it("rejects malformed and unpinned entries", () => {
    const original = manifestFixture();
    expect(() => compileCapabilityManifest(null)).toThrow(
      "integration.manifest.invalid",
    );
    expect(() =>
      compileCapabilityManifest({
        ...original,
        scenarios: [{ ...original.scenarios[0]!, image: "node:22-alpine" }],
      }),
    ).toThrow("integration.manifest.invalid");
  });

  it("detects descriptor evidence mutation", () => {
    const original = manifestFixture();
    const evidencePath = resolve(
      integrationRoot,
      original.evidence[0]!.descriptorArtifact.path,
    );
    const bytes = readFileSync(evidencePath);
    try {
      writeFileSync(evidencePath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(evidencePath, bytes);
    }
  });

  it("detects scenario adapter mutation", () => {
    const original = manifestFixture();
    const adapterPath = resolve(
      integrationRoot,
      original.scenarios[0]!.fixtureAdapter.path,
    );
    const bytes = readFileSync(adapterPath);
    try {
      writeFileSync(adapterPath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(adapterPath, bytes);
    }
  });

  it("detects scenario oracle mutation", () => {
    const original = manifestFixture();
    const oraclePath = resolve(
      integrationRoot,
      original.scenarios[0]!.scenarioOracle.path,
    );
    const bytes = readFileSync(oraclePath);
    try {
      writeFileSync(oraclePath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(oraclePath, bytes);
    }
  });

  it("rejects substituted runtime artifact authority", () => {
    const original = manifestFixture();
    const scenario = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    );
    expect(scenario?.runtimeArtifacts).toHaveLength(2);
    const mutated = structuredClone(original);
    const selected = mutated.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    );
    selected!.runtimeArtifacts[0]!.sha256 = "0".repeat(64);
    expect(() => {
      verifyManifestEvidence(mutated, integrationRoot);
    }).toThrow("integration.manifest.evidence-digest");
  });

  // eslint-disable-next-line max-lines-per-function
  it("waits for the traced Codex TUI turn before sending the authenticated double Ctrl-D quit sequence", () => {
    const scenario = manifestFixture().scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    )!;
    expect(Buffer.from(scenario.terminalInputBase64, "base64")).toEqual(
      Buffer.from([4, 4]),
    );
    expect(scenario.postCompletionInputByteLength).toBe(2);
    expect(scenario.postCompletionControl).toBe("none");
    expect(scenario.waitForSemanticCompletionBeforeTerminalAction).toBe(true);
    expect(scenario.nativeReadiness).toEqual({ kind: "challenge-marker" });
    expect(
      manifestFixture()
        .scenarios.filter(
          ({ scenarioId }) => scenarioId !== scenario.scenarioId,
        )
        .some(
          ({ nativeReadiness }) =>
            nativeReadiness?.kind === "codex-idle-prompt",
        ),
    ).toBe(false);
    const challenge = "a".repeat(64);
    const actions = compileInteractivePtyActions(
      scenario,
      Buffer.concat([
        Buffer.from(`${challenge}\n`),
        Buffer.from(scenario.terminalInputBase64, "base64"),
      ]),
    );
    expect(actions.map(({ action }) => action)).toEqual([
      "resize",
      "input",
      "checkpoint-process-topology",
      "wait-for-semantic-completion",
      "input",
      "input",
    ]);
    expect(actions[1]).toEqual({
      action: "input",
      byteLength: 65,
      inputSha256: createHash("sha256")
        .update(Buffer.from(`${challenge}\n`))
        .digest("hex"),
    });
    expect(actions.at(-1)).toEqual({
      action: "input",
      byteLength: 1,
      inputSha256: createHash("sha256")
        .update(Buffer.from([4]))
        .digest("hex"),
    });
    expect(actions.at(-2)).toEqual(actions.at(-1));
    expect(actions[2]).toEqual({
      action: "checkpoint-process-topology",
      topology: "root-with-contained-process-set",
    });
    const source = readFileSync(
      resolve(integrationRoot, scenario.scenarioProcess.path),
      "utf8",
    );
    const challengeRead = source.indexOf(
      "const readinessChallenge = await readReadinessChallenge();\n",
    );
    const startupPrompt = source.indexOf("      prompt,\n");
    const explicitHookEnablement = source.indexOf(
      '      "--enable",\n      "hooks",\n',
    );
    const explicitHookTrust = source.indexOf(
      '      "--dangerously-bypass-hook-trust",\n',
    );
    const modelRequest = source.indexOf(
      "  await waitForModelRequestBeforeDeadline({\n",
    );
    const traceDeadline = source.indexOf(
      "  const traceDeadline = deadline - 3_000;\n",
      challengeRead,
    );
    const terminalWait = source.indexOf(
      "  await waitForCodexTurnTerminal(traceDeadline);\n",
      traceDeadline,
    );
    const readinessRelease = source.indexOf(
      "AGENTSCOPE_PTY_READY:${readinessChallenge}",
    );
    const checkpointAcknowledgement = source.indexOf(
      "      await checkpointSignal;\n",
      readinessRelease,
    );
    const modelResponse = source.indexOf(
      '      response.writeHead(200, { "content-type": "text/event-stream" });\n',
      checkpointAcknowledgement,
    );
    const codexJoin = source.indexOf(
      "  await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);\n",
      modelRequest,
    );
    const traceQueryAfterJoin = source.indexOf(
      "  const summary = await waitForTraceSummary(traceDeadline);\n",
      terminalWait,
    );
    expect(startupPrompt).toBeGreaterThan(-1);
    expect(challengeRead).toBeGreaterThan(-1);
    expect(challengeRead).toBeLessThan(startupPrompt);
    expect(source).toContain(
      "const expectedAssistantMessage = `AGENTSCOPE_CODEX_RESPONSE:${readinessChallenge}`;",
    );
    expect(source).toContain(
      "const terminalCompletionMarker = `AGENTSCOPE_PTY_COMPLETE:${readinessChallenge}`;",
    );
    expect(source).toContain(
      'body.replace(\n        "AGENTSCOPE_PTY_COMPLETE",\n        expectedAssistantMessage,\n      )',
    );
    expect(source).toContain("baseUrl: `${modelGateway.endpoint}/v1`,");
    expect(source).toContain(
      "codexLedgerBaseline = readCodexSessionLedgerRecords(homeDescriptor);",
    );
    expect(source).not.toContain("readFileSync(`/proc/${pid}/stat`");
    expect(source).not.toContain('readdirSync("/proc"');
    expect(source).toContain(
      "const checkpointSignal = waitForCheckpointSignal();",
    );
    expect(source).toContain('process.once("SIGUSR2", onSignal);');
    expect(explicitHookEnablement).toBeGreaterThan(-1);
    expect(explicitHookTrust).toBeGreaterThan(-1);
    expect(explicitHookEnablement).toBeLessThan(explicitHookTrust);
    expect(explicitHookTrust).toBeLessThan(startupPrompt);
    expect(source).toContain(
      "`integration.fixture.codex-${interactiveFailurePhase}\\n`",
    );
    expect(source).toContain(
      'if (worktree !== "/worktree")\n  throw new Error("integration.codex.environment-AGENTSCOPE_WORKTREE");',
    );
    expect(source).toContain(
      "value.discovery.configurationLocationCount !== 2",
    );
    expect(source).toContain(
      '[projects."/worktree"]\\ntrust_level = "trusted"\\n',
    );
    const rootLogDirectory = source.indexOf(
      "const configuration = `log_dir = ${JSON.stringify(codexDiagnosticLogDirectory)}\\n${createCodexInternalProviderConfiguration(",
    );
    const providerConfiguration = source.indexOf(
      "    baseUrl: `${modelGateway.endpoint}/v1`,",
      rootLogDirectory,
    );
    const projectConfiguration = source.indexOf(
      '[projects."/worktree"]\\ntrust_level = "trusted"\\n',
      providerConfiguration,
    );
    expect(rootLogDirectory).toBeGreaterThan(-1);
    expect(providerConfiguration).toBeGreaterThan(rootLogDirectory);
    expect(projectConfiguration).toBeGreaterThan(providerConfiguration);
    expect(source).not.toContain(
      "})}\\nlog_dir = ${JSON.stringify(codexDiagnosticLogDirectory)}",
    );
    expect(source).toContain(
      'RUST_LOG: "codex_hooks::engine::command_runner=trace"',
    );
    expect(source).not.toContain('RUST_LOG: "codex_hooks=trace"');
    const traceTerminalPhase = source.indexOf(
      '  recordInteractivePhase("trace-terminal");\n',
      traceDeadline,
    );
    const traceSettlementPhase = source.indexOf(
      '    record: () => recordInteractivePhase("trace-settlement"),\n',
      traceDeadline,
    );
    const traceSearchPhase = source.indexOf(
      '    record: () => recordInteractivePhase("trace-search"),\n',
    );
    const traceSearchResultPhase = source.indexOf(
      '    record: () => recordInteractivePhase("trace-search-result"),\n',
    );
    expect(traceTerminalPhase).toBeGreaterThan(modelRequest);
    expect(terminalWait).toBeLessThan(traceTerminalPhase);
    expect(traceTerminalPhase).toBeLessThan(codexJoin);
    expect(codexJoin).toBeLessThan(traceSettlementPhase);
    expect(traceSettlementPhase).toBeLessThan(traceQueryAfterJoin);
    expect(traceSearchPhase).toBeGreaterThan(-1);
    expect(traceSearchResultPhase).toBeGreaterThan(-1);
    expect(source).not.toContain('      "--harness",\n      "codex",\n');
    expect(source).toContain(
      "if (!/\\/agentscope-hook-v1-[a-f0-9]{64}-d5000$/u.test(launcher))",
    );
    expect(source).not.toContain("runDirectHookProbe");
    expect(source).not.toContain("options.input");
    expect(source).not.toContain("readHookOperationalHealth");
    const terminalObservation = source.indexOf(
      "    const turnId = codexTurnTerminalIdAfterBaseline(\n",
    );
    expect(source).toContain("localSqliteAcceptanceBaseline");
    expect(source).toContain("classifyLocalSqliteOutcomeAfterBaseline");
    expect(source).toContain("openOperationalStateHealth");
    const traceSummaryWait = source.slice(
      source.indexOf("const waitForTraceSummary ="),
      source.indexOf("let completed = false;"),
    );
    const preQueryDeadline = traceSummaryWait.indexOf(
      '  if (bootNow() >= traceDeadline)\n    throw new Error("integration.codex.trace-deadline");\n',
    );
    const traceSearchPhaseInWait = traceSummaryWait.indexOf(
      '    record: () => recordInteractivePhase("trace-search"),\n',
      preQueryDeadline,
    );
    const boundedQuery = traceSummaryWait.indexOf(
      "          : await readTraceSummary(traceSearchDeadlines),\n",
      traceSearchPhaseInWait,
    );
    const lifecycleSettlement = traceSummaryWait.indexOf(
      "    const reporterSettled = localSqliteReporterSettled(\n" +
        "      localSqliteLifecycleDescriptor,\n" +
        "    );\n",
      traceSearchPhaseInWait,
    );
    const terminalObservationCut = traceSummaryWait.indexOf(
      "    const observationClosed = traceSearchDeadlines === null;\n",
      lifecycleSettlement,
    );
    const boundedBackoff = traceSummaryWait.indexOf(
      "    await waitWithinObservationDeadline({\n      deadline: traceDeadline,\n      maximumWaitMilliseconds: 100,\n",
      lifecycleSettlement,
    );
    const reporterSettledPhase = source.indexOf(
      '    record: () => recordInteractivePhase("trace-reporter-settled"),\n',
      source.indexOf("const waitForTraceSummary ="),
    );
    const acceptancePhase = source.indexOf(
      '    record: () => recordInteractivePhase("trace-acceptance"),\n',
      reporterSettledPhase,
    );
    const traceSummaryFunction = source.slice(
      source.indexOf("const readTraceSummary ="),
      source.indexOf("const waitForCodexTurnTerminal ="),
    );
    const joinedSearch = traceSummaryFunction.indexOf(
      "  const { stdout, traceTimedOut, traceUnavailable } = await run(\n",
    );
    const exactSessionFilter = traceSummaryFunction.indexOf(
      '      "--session",\n      codexSessionId,\n',
      joinedSearch,
    );
    const guardedRawResult = traceSummaryFunction.indexOf(
      "    !terminalObservationBeforeDeadline({\n",
      joinedSearch,
    );
    const resultParsing = traceSummaryFunction.indexOf(
      '  const records = parseMachine(stdout, "agentscope traces search");\n',
      guardedRawResult,
    );
    const guardedClassification = traceSummaryFunction.indexOf(
      "  return classifyTraceSearchRecordsBeforeDeadline({\n",
      resultParsing,
    );
    expect(terminalObservation).toBeGreaterThan(-1);
    expect(preQueryDeadline).toBeGreaterThan(-1);
    expect(traceSearchPhaseInWait).toBeGreaterThan(preQueryDeadline);
    expect(lifecycleSettlement).toBeGreaterThan(traceSearchPhaseInWait);
    expect(terminalObservationCut).toBeGreaterThan(lifecycleSettlement);
    expect(boundedQuery).toBeGreaterThan(lifecycleSettlement);
    expect(boundedBackoff).toBeGreaterThan(lifecycleSettlement);
    expect(reporterSettledPhase).toBeGreaterThan(lifecycleSettlement);
    expect(acceptancePhase).toBeGreaterThan(reporterSettledPhase);
    expect(traceSearchResultPhase).toBeGreaterThan(acceptancePhase);
    expect(joinedSearch).toBeGreaterThan(-1);
    expect(exactSessionFilter).toBeGreaterThan(joinedSearch);
    expect(guardedRawResult).toBeGreaterThan(exactSessionFilter);
    expect(guardedRawResult).toBeGreaterThan(joinedSearch);
    expect(resultParsing).toBeGreaterThan(guardedRawResult);
    expect(guardedClassification).toBeGreaterThan(resultParsing);
    expect(traceSummaryFunction).toContain("  if (traceTimedOut) {\n");
    expect(traceSummaryFunction).toContain(
      "        deadline: observationDeadline,\n",
    );
    expect(traceSummaryFunction).toContain(
      "      monotonicDeadline: childDeadline,\n",
    );
    expect(traceSummaryFunction).toContain(
      "      deadline: attemptDeadline,\n",
    );
    expect(traceSummaryFunction).toContain(
      "  if (traceUnavailable) return null;\n",
    );
    expect(traceSummaryFunction).not.toContain(
      'recordInteractivePhase("trace-search-',
    );
    const terminalCompletion = source.indexOf(
      "    process.stdout.write(`${terminalCompletionMarker}\\r\\n`, (error) =>",
      terminalObservation,
    );
    expect(terminalCompletion).toBeGreaterThan(terminalWait);
    expect(terminalCompletion).toBeLessThan(codexJoin);
    const postJoinDeadline = source.indexOf(
      "  recordTerminalObservationBeforeDeadline({\n",
      codexJoin,
    );
    expect(postJoinDeadline).toBeGreaterThan(codexJoin);
    expect(postJoinDeadline).toBeLessThan(traceSettlementPhase);
    expect(source).not.toContain("const waitForTraceSettlement =");
    expect(source).toContain(
      "  await publishTerminalCompletionBeforeDeadline({",
    );
    expect(source).toContain('            child.kill("SIGKILL");\n');
    expect(source).toContain(
      "      if (timer !== undefined) clearTimeout(timer);\n",
    );
    expect(modelRequest).toBeGreaterThan(startupPrompt);
    expect(traceDeadline).toBeGreaterThan(challengeRead);
    expect(traceDeadline).toBeLessThan(modelRequest);
    expect(source).toContain(
      "  await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);\n",
    );
    expect(source).not.toContain("  await waitForModelRequest();\n");
    expect(source).toContain("{ monotonicDeadline: traceDeadline },\n");
    expect(source).toContain(
      '    await cli(["harness", "status", "codex"], "agentscope harness status", {\n      monotonicDeadline: traceDeadline,\n    }),\n',
    );
    const evidenceEncoding = source.indexOf(
      "  const encodedEvidence = Buffer.from(JSON.stringify(evidence)).toString(\n",
    );
    const guardedEvidenceWrite = source.indexOf(
      '  recordTerminalObservationBeforeDeadline({\n    deadline: traceDeadline,\n    now: bootNow,\n    record: () =>\n      writeFileSync(\n        join(ledger, "fixture-result.json"),\n',
      evidenceEncoding,
    );
    const completed = source.indexOf(
      "  completed = true;\n",
      guardedEvidenceWrite,
    );
    expect(evidenceEncoding).toBeGreaterThan(traceQueryAfterJoin);
    expect(guardedEvidenceWrite).toBeGreaterThan(evidenceEncoding);
    expect(completed).toBeGreaterThan(guardedEvidenceWrite);
    expect(readinessRelease).toBeGreaterThan(-1);
    expect(checkpointAcknowledgement).toBeGreaterThan(readinessRelease);
    expect(modelResponse).toBeGreaterThan(checkpointAcknowledgement);
    expect(codexJoin).toBeGreaterThan(modelRequest);
    expect(traceQueryAfterJoin).toBeGreaterThan(codexJoin);
    expect(
      source.indexOf("  await modelGateway.settle();\n", modelRequest),
    ).toBeLessThan(terminalWait);
    expect(source.match(/AGENTSCOPE_PTY_READY/gu)).toHaveLength(1);
    expect(source).not.toContain("AGENTSCOPE_PTY_READINESS_CHALLENGE");
    expect(source).not.toContain("codex-hook-completion-probe");
  });

  it("rejects Codex native readiness on a different harness row", () => {
    const original = manifestFixture();
    const scenarios = structuredClone(original.scenarios);
    scenarios[1]!.nativeReadiness = {
      kind: "codex-idle-prompt",
      harness: "codex",
      exactHarnessVersion: "0.149.1",
      text: "›",
      bold: true,
      dim: false,
    };
    expect(() =>
      compileCapabilityManifest(
        withIdentity({
          manifestVersion: 1,
          requiredRepresentativeIds: original.requiredRepresentativeIds,
          evidence: original.evidence,
          scenarios,
        }),
      ),
    ).toThrow("integration.manifest.invalid");
  });

  it("rejects challenge readiness on a non-Codex harness row", () => {
    const original = manifestFixture();
    const scenarios = structuredClone(original.scenarios);
    scenarios[1]!.nativeReadiness = { kind: "challenge-marker" };
    expect(() =>
      compileCapabilityManifest(
        withIdentity({
          manifestVersion: 1,
          requiredRepresentativeIds: original.requiredRepresentativeIds,
          evidence: original.evidence,
          scenarios,
        }),
      ),
    ).toThrow("integration.manifest.invalid");
  });

  it("selects mutually isolated MockServer expectations per scenario", () => {
    const manifest = manifestFixture();
    const initialization = createMockServerInitialization() as readonly {
      id: string;
    }[];
    const selectedIds = (scenarioId: string) => {
      const scenario = manifest.scenarios.find(
        (candidate) => candidate.scenarioId === scenarioId,
      );
      return scenario!.modelRoutes.map((routeId) => {
        const index = MODEL_PROTOCOL_ROUTES.findIndex(
          (route) => route.routeId === routeId,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return initialization[index]!.id;
      });
    };
    expect(selectedIds("codex-tui-trace-smoke")).toEqual([
      "codex-tui-responses",
    ]);
    expect(selectedIds("fixture-process-smoke")).not.toContain(
      "codex-tui-responses",
    );
  });

  it("prepares every selected scenario material verifier image", () => {
    const manifest = compileCapabilityManifest(manifestFixture());
    const codex = manifest.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    )!;
    expect(codex.image).toBe(
      "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2",
    );
    expect(codex.image).not.toBe(
      manifest.scenarios.find(
        ({ scenarioId }) => scenarioId === "fixture-process-smoke",
      )!.image,
    );
    const material = manifest.evidence.find(
      ({ evidenceId }) => evidenceId === codex.harnessEvidenceId,
    )!.material;
    expect(material.kind).toBe("npm");
    if (material.kind !== "npm") throw new Error("test.material");
    expect(material.verifierImage).toBe(
      "node@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae",
    );
    expect(material.verifierNpmVersion).toBe("11.19.1");
    expect(capabilityScenarioImages(manifest, [codex.scenarioId])).toEqual(
      [codex.image, codex.mockServerImage, material.verifierImage].sort(),
    );
    for (const scenarioIds of [
      [],
      [codex.scenarioId, codex.scenarioId],
      ["missing"],
    ])
      expect(() => capabilityScenarioImages(manifest, scenarioIds)).toThrow(
        "integration.manifest.image-selection",
      );
  });

  it("rejects descriptor evidence that contradicts its manifest binding", () => {
    const original = manifestFixture();
    const evidencePath = resolve(
      integrationRoot,
      original.evidence[0]!.descriptorArtifact.path,
    );
    const bytes = readFileSync(evidencePath);
    try {
      const descriptor = JSON.parse(bytes.toString("utf8")) as {
        harnessId: string;
      };
      descriptor.harnessId = "other-harness";
      const mutated = `${JSON.stringify(descriptor, undefined, 2)}\n`;
      writeFileSync(evidencePath, mutated);
      const manifest = structuredClone(original);
      manifest.evidence[0]!.descriptorArtifact.sha256 = createHash("sha256")
        .update(mutated)
        .digest("hex");
      expect(() => {
        verifyManifestEvidence(manifest, integrationRoot);
      }).toThrow("integration.manifest.evidence-contract");
    } finally {
      writeFileSync(evidencePath, bytes);
    }
  });
});

describe("integration npm material policy", () => {
  it("detects scenario process mutation", () => {
    const original = manifestFixture();
    const processPath = resolve(
      integrationRoot,
      original.scenarios[0]!.scenarioProcess.path,
    );
    const bytes = readFileSync(processPath);
    try {
      writeFileSync(processPath, `${bytes.toString("utf8")}\n`);
      expect(() => {
        verifyManifestEvidence(original, integrationRoot);
      }).toThrow("integration.manifest.evidence-digest");
    } finally {
      writeFileSync(processPath, bytes);
    }
  });

  it("rejects moving or incomplete npm material", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        evidence: [
          {
            ...original.evidence[0]!,
            material: {
              kind: "npm",
              platformIdentity: `sha256-${"9".repeat(64)}`,
              verifierImage: `node@sha256:${"f".repeat(64)}`,
              registry: "https://registry.npmjs.org/",
              packages: [
                {
                  attestations: {
                    url: "https://registry.npmjs.org/-/npm/v1/attestations/@vendor%2fharness@1.0.0",
                    bytes: 1,
                    sha256: "f".repeat(64),
                  },
                  installName: "@vendor/harness",
                  packageName: "@vendor/harness",
                  version: "1.0.0",
                  tarballUrl: "https://registry.npmjs.org/latest.tgz",
                  bytes: 1,
                  integrity: "moving",
                  shasum: "0".repeat(40),
                },
              ],
              provenance: {
                repository: "https://github.com/vendor/harness",
                sourceCommit: "0".repeat(40),
                tag: "v1.0.0",
                workflowPath: ".github/workflows/release.yml",
              },
            },
          },
        ],
      }),
    ).toThrow("integration.manifest.invalid");
  });
});

describe("integration signed-manifest material policy", () => {
  const signedEvidence = (original: CapabilityManifest) => ({
    ...original.evidence[0]!,
    representativeVersion: "2.1.89",
    material: {
      kind: "signed-release-manifest" as const,
      distributionId: "vendor-tool",
      version: "2.1.89",
      platform: "linux-x64",
      platformIdentity: `sha256-${"9".repeat(64)}`,
      verifierImage: original.scenarios[0]!.image,
      binary: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/linux-x64/tool",
        bytes: 1,
        sha256: "a".repeat(64),
        executableName: "tool",
      },
      manifest: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/manifest.json",
        bytes: 1,
        sha256: "b".repeat(64),
      },
      signature: {
        url: "https://downloads.vendor.invalid/releases/2.1.89/manifest.json.sig",
        bytes: 1,
        sha256: "c".repeat(64),
      },
      signingKey: {
        url: "https://downloads.vendor.invalid/keys/release.asc",
        bytes: 1,
        sha256: "d".repeat(64),
        fingerprint: "A".repeat(40),
        signerFingerprint: "A".repeat(40),
        signatureHashAlgorithm: "sha512" as const,
        uid: "Vendor Release Signing <security@vendor.invalid>",
      },
    },
    admission: {
      evidenceSlot: "vendor-tool-v1",
      eligibleRange: {
        minimumInclusive: "2.1.89",
        maximumExclusive: "3.0.0",
      },
      distributionReference: "signed-manifest:vendor-tool@2.1.89#linux-x64",
      component: {
        fixture: {
          path: "packages/harnesses/codex/fixtures/native/a.json",
          sha256: "e".repeat(64),
        },
        adapterArtifact: {
          path: "packages/harnesses/codex/dist/index.js",
          sha256: "f".repeat(64),
        },
        mappingArtifact: {
          path: "packages/harnesses/codex/dist/mapping.js",
          sha256: "0".repeat(64),
        },
        componentEvidenceDigest: `component-sha256-${"1".repeat(64)}`,
      },
    },
  });

  it("compiles a harness-neutral exact-version signed release", () => {
    const original = manifestFixture();
    const evidence = signedEvidence(original);
    const scenario = original.scenarios.find(
      ({ harnessEvidenceId }) =>
        harnessEvidenceId === original.evidence[0]!.evidenceId,
    )!;
    const compiled = compileCapabilityManifest(
      withIdentity({
        ...original,
        evidence: [evidence],
        requiredRepresentativeIds: [evidence.evidenceId],
        scenarios: [scenario],
      }),
    );
    expect(compiled.evidence[0]?.material.kind).toBe("signed-release-manifest");
  });

  it("rejects origin and exact-version path substitution", () => {
    const original = manifestFixture();
    const evidence = signedEvidence(original);
    for (const manifestUrl of [
      "https://other.vendor.invalid/releases/2.1.89/manifest.json",
      "https://downloads.vendor.invalid/releases/latest/manifest.json",
    ])
      expect(() =>
        compileCapabilityManifest({
          ...original,
          evidence: [
            {
              ...evidence,
              material: {
                ...evidence.material,
                manifest: { ...evidence.material.manifest, url: manifestUrl },
              },
            },
          ],
        }),
      ).toThrow("integration.manifest.invalid");
  });
});

describe("integration capability execution modes", () => {
  it("rejects a headless/interactive output-contract mismatch", () => {
    const original = manifestFixture();
    expect(() =>
      compileCapabilityManifest({
        ...original,
        scenarios: [
          {
            ...original.scenarios[0]!,
            executionMode: "interactive",
            outputContract: "jsonl",
          },
        ],
      }),
    ).toThrow("integration.manifest.invalid");
  });

  it("rejects unknown or headless raw terminal controls", () => {
    const original = manifestFixture();
    const interactive = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    )!;
    for (const postCompletionControl of [
      "eof",
      "raw-control-sequence",
      ["interrupt-byte", "eof"],
    ])
      expect(() =>
        compileCapabilityManifest({
          ...original,
          scenarios: [
            { ...interactive, postCompletionControl } as typeof interactive,
          ],
        }),
      ).toThrow("integration.manifest.invalid");
    expect(() =>
      compileCapabilityManifest({
        ...original,
        scenarios: [
          {
            ...original.scenarios[0]!,
            postCompletionControl: "interrupt-byte",
            waitForSemanticCompletionBeforeTerminalAction: true,
          },
        ],
      }),
    ).toThrow("integration.manifest.invalid");
  });
});

describe("integration capability selection", () => {
  it("selects by harness, tag, scenario, and deterministic weighted shard", () => {
    const original = manifestFixture();
    const fixtureEvidence = original.evidence.find(
      ({ evidenceId }) => evidenceId === "fixture-process-v1",
    )!;
    const fixtureScenario = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "fixture-process-smoke",
    )!;
    const second = {
      ...fixtureScenario,
      scenarioId: "fixture-process-regression",
      tags: ["nightly"],
      shardWeight: 200,
    };
    const third = {
      ...fixtureScenario,
      scenarioId: "fixture-process-small",
      tags: ["nightly"],
      shardWeight: 50,
    };
    const compiled = compileCapabilityManifest(
      withIdentity({
        ...original,
        evidence: [fixtureEvidence],
        requiredRepresentativeIds: [fixtureEvidence.evidenceId],
        scenarios: [third, fixtureScenario, second],
      }),
    );
    expect(selectCapabilityScenarios(compiled, { tag: "smoke" })).toHaveLength(
      1,
    );
    expect(
      selectCapabilityScenarios(compiled, { harnessId: "fixture-process" }),
    ).toHaveLength(3);
    expect(
      selectCapabilityScenarios(compiled, {
        scenarioId: "fixture-process-regression",
      })[0]?.scenarioId,
    ).toBe("fixture-process-regression");
    const shards = partitionCapabilityScenarios(compiled.scenarios, 2);
    expect(
      shards.map((shard) => shard.map(({ scenarioId }) => scenarioId)),
    ).toEqual([
      ["fixture-process-regression"],
      ["fixture-process-small", "fixture-process-smoke"],
    ]);
    expect(
      selectCapabilityScenarios(compiled, { shard: { index: 1, total: 2 } }),
    ).toEqual(shards[1]);
  });

  it("rejects empty and hostile selectors and invalid shards", () => {
    const compiled = compileCapabilityManifest(manifestFixture());
    expect(() =>
      selectCapabilityScenarios(compiled, { tag: "missing" }),
    ).toThrow("integration.manifest.selection-empty");
    expect(() =>
      selectCapabilityScenarios(compiled, { unexpected: true } as never),
    ).toThrow("integration.manifest.selector");
    for (const shard of [
      { index: -1, total: 1 },
      { index: 1, total: 1 },
      { index: 0, total: 4 },
    ])
      expect(() => selectCapabilityScenarios(compiled, { shard })).toThrow(
        "integration.manifest.shard",
      );
  });
});
