import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { z } from "zod";
import type { HarnessComponentEvidence } from "@agentscope/harnesses-core/testing";

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

const publicComponentEvidence = (
  harness: "codex" | "claude-code",
): HarnessComponentEvidence => {
  // Ordinary Node ESM self-reference selects the existing public import export.
  const source =
    harness === "codex"
      ? 'import {codexComponentEvidence} from "@agentscope/harness-codex/testing"; console.log(JSON.stringify(codexComponentEvidence));'
      : 'import {claudeCodeComponentAdapter} from "@agentscope/harness-claude-code/testing"; console.log(JSON.stringify(claudeCodeComponentAdapter.componentEvidence));';
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: resolve(integrationRoot, `../../packages/harnesses/${harness}`),
      encoding: "utf8",
      maxBuffer: 4096,
      timeout: 3000,
    },
  );
  return JSON.parse(output) as HarnessComponentEvidence;
};

describe("actual catalog component source attribution", () => {
  it.each(["codex", "claude-code"] as const)(
    "binds %s source bytes and public component digest without promoting its fixture",
    (harness) => {
      const manifest = compileCapabilityManifest(manifestFixture());
      const row = manifest.evidence.find(
        ({ harnessId }) => harnessId === harness,
      )!;
      const admission = row.admission!;
      const component = publicComponentEvidence(harness);
      expect(admission.component.componentEvidenceDigest).toBe(
        component.componentDigest,
      );
      expect(admission.evidenceSlot).toBe(component.evidenceSlot);
      expect(row.representativeVersion).toBe(component.testedVersion);
      expect(admission.eligibleRange.minimumInclusive).toBe(
        component.testedVersion,
      );
      const root = resolve(integrationRoot, "../..");
      for (const artifact of [
        admission.component.fixture,
        admission.component.adapterArtifact,
        admission.component.mappingArtifact,
      ]) {
        const bytes = readFileSync(resolve(root, artifact.path));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          artifact.sha256,
        );
      }
      const fixture = JSON.parse(
        readFileSync(resolve(root, admission.component.fixture.path), "utf8"),
      ) as {
        governance: {
          provenance: unknown;
          representative: { scenarioId: string };
        };
      };
      expect(fixture.governance.provenance).toMatchObject({
        captureKind: "synthetic",
        artifactAuthority: {
          status: "unresolved",
          reason: "independent-integrity-unavailable",
        },
      });
      const runtime = manifest.scenarios.find(
        ({ harnessEvidenceId }) => harnessEvidenceId === row.evidenceId,
      )!;
      expect(runtime.executionMode).toBe("interactive");
      expect(runtime.outputContract).toBe("semantic-pty");
      expect(fixture.governance.representative.scenarioId).toBe(
        component.scenarioId,
      );
      expect(runtime.scenarioId).not.toBe(component.scenarioId);
      verifyManifestEvidence(manifest, integrationRoot);
    },
  );

  it.each(["fixture", "adapterArtifact", "mappingArtifact"] as const)(
    "rejects substituted %s bytes even with a recomputed catalog identity",
    (key) => {
      const manifest = manifestFixture();
      manifest.evidence[0]!.admission!.component[key].sha256 = "0".repeat(64);
      expect(() => {
        verifyManifestEvidence(
          compileCapabilityManifest(withIdentity(manifest)),
          integrationRoot,
        );
      }).toThrow("integration.manifest.evidence-digest");
    },
  );

  it("does not accept a catalog label as an actual support result", () => {
    const manifest = manifestFixture();
    expect(() => {
      compileCapabilityManifest(
        withIdentity({
          ...manifest,
          evidence: manifest.evidence.map((row) => ({
            ...row,
            supportStatus: "passed",
          })),
        }),
      );
    }).toThrow("integration.manifest.invalid");
  });
});

const verifyActualComponentMetadata = (fixture: unknown): void => {
  const source = readFileSync(
    new URL("./manifest.ts", import.meta.url),
    "utf8",
  );
  const schemas = source.slice(
    source.indexOf("const id ="),
    source.indexOf("const dockerImage ="),
  );
  const verifier = source.slice(
    source.indexOf("const verifyComponentFixture ="),
    source.indexOf("export const verifyManifestEvidence ="),
  );
  expect(schemas).not.toBe("");
  expect(verifier).not.toBe("");
  runInNewContext(
    transpileModule(
      `${schemas}\n${verifier}\nverifyComponentFixture(bytes, evidence);`,
      {},
    ).outputText,
    {
      z,
      bytes: Buffer.from(JSON.stringify(fixture)),
      evidence: {
        harnessId: "codex",
        representativeVersion: "1.2.3",
        evidenceId: "runtime",
        admission: { evidenceSlot: "codex-interactive" },
      },
    },
    { timeout: 1000 },
  );
};

describe("component metadata does not own runtime scenario admission", () => {
  const component = () => ({
    fixtureVersion: 1,
    harnessId: "codex",
    harnessVersion: "1.2.3",
    governance: {
      provenance: {
        captureKind: "synthetic",
        artifactAuthority: {
          status: "unresolved",
          reason: "independent-integrity-unavailable",
        },
      },
      representative: {
        scenarioId: "codex-unit-case",
        representativeVersion: "1.2.3",
        evidenceSlot: "codex-component",
      },
    },
  });
  it("accepts synthetic component regression metadata without a live scenario or slot alias", () => {
    expect(() => {
      verifyActualComponentMetadata(component());
    }).not.toThrow();
  });
  it("accepts authenticated component provenance without treating its digest as runtime authority", () => {
    const fixture = component();
    expect(() => {
      verifyActualComponentMetadata({
        ...fixture,
        governance: {
          ...fixture.governance,
          provenance: {
            captureKind: "disposable-hermetic",
            artifactAuthority: {
              status: "authenticated",
              digest: `sha256-${"f".repeat(64)}`,
            },
          },
        },
      });
    }).not.toThrow();
  });
  it.each([
    {
      captureKind: "synthetic",
      artifactAuthority: {
        status: "authenticated",
        digest: `sha256-${"f".repeat(64)}`,
      },
    },
    {
      captureKind: "synthetic",
      artifactAuthority: { status: "unresolved", reason: "other" },
    },
    {
      captureKind: "disposable-hermetic",
      artifactAuthority: {
        status: "unresolved",
        reason: "independent-integrity-unavailable",
      },
    },
    {
      captureKind: "disposable-hermetic",
      artifactAuthority: { status: "authenticated", digest: "bad" },
    },
  ])("rejects malformed provenance %#", (provenance) => {
    const fixture = component();
    expect(() => {
      verifyActualComponentMetadata({
        ...fixture,
        governance: { ...fixture.governance, provenance },
      });
    }).toThrow("integration.manifest.fixture-provenance");
  });
  it.each([
    { harnessId: "claude-code" },
    { harnessVersion: "9.9.9" },
    {
      governance: {
        ...component().governance,
        representative: {
          ...component().governance.representative,
          representativeVersion: "9.9.9",
        },
      },
    },
    {
      governance: {
        ...component().governance,
        representative: {
          ...component().governance.representative,
          evidenceSlot: "invalid/slot",
        },
      },
    },
  ])("rejects component identity/version drift %#", (change) => {
    expect(() => {
      verifyActualComponentMetadata({ ...component(), ...change });
    }).toThrow("integration.manifest.fixture-provenance");
  });
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
    expect(codex?.admission?.distributionReference).toBe(
      "npm:@openai/codex@0.149.1",
    );
  });

  it("keeps authenticated diagnostic material distinct from support admission", () => {
    const original = manifestFixture();
    const codex = original.evidence.find(
      ({ evidenceId }) => evidenceId === "codex-0-149-1",
    )!;
    expect(codex.material.kind).toBe("npm");
    expect(codex.admission?.component.componentEvidenceDigest).toMatch(
      /^component-sha256-[a-f\d]{64}$/u,
    );

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

  it("rejects substituted runtime artifact authority", () => {
    const original = manifestFixture();
    const scenario = original.scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    );
    expect(scenario?.runtimeArtifacts).toHaveLength(5);
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
  it("admits the Codex prompt only after readiness and quits after the traced TUI turn", () => {
    const scenario = manifestFixture().scenarios.find(
      ({ scenarioId }) => scenarioId === "codex-tui-trace-smoke",
    )!;
    expect(Buffer.from(scenario.terminalInputBase64, "base64")).toEqual(
      Buffer.concat([
        Buffer.from(
          "\x1b[200~Reply with one short confirmation and do not use tools.\x1b[201~\x1b[13u",
        ),
        Buffer.from("\x1b[200~/exit\x1b[201~\x1b[13u"),
      ]),
    );
    expect(scenario.postCompletionInputByteLength).toBe(22);
    expect(scenario.postCompletionControl).toBe("none");
    expect(scenario.waitForSemanticCompletionBeforeTerminalAction).toBe(true);
    expect(scenario.nativeReadiness).toEqual({
      kind: "codex-challenge-idle-prompt",
      harness: "codex",
      exactHarnessVersion: "0.149.1",
      text: "›",
      bold: true,
      dim: false,
    });
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
      "input",
      "input",
      "wait-for-semantic-completion",
      "wait-for-post-submission-idle-prompt",
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
    expect(actions[3]).toEqual({
      action: "input",
      byteLength: Buffer.byteLength(
        "\x1b[200~Reply with one short confirmation and do not use tools.\x1b[201~",
      ),
      inputSha256: createHash("sha256")
        .update(
          Buffer.from(
            "\x1b[200~Reply with one short confirmation and do not use tools.\x1b[201~",
          ),
        )
        .digest("hex"),
    });
    expect(actions[4]).toEqual({
      action: "input",
      byteLength: 5,
      inputSha256: createHash("sha256").update("\x1b[13u").digest("hex"),
    });
    expect(actions.at(-2)).toEqual({
      action: "input",
      byteLength: 17,
      inputSha256: createHash("sha256")
        .update(Buffer.from("\x1b[200~/exit\x1b[201~"))
        .digest("hex"),
    });
    expect(actions.at(-1)).toEqual({
      action: "input",
      byteLength: 5,
      inputSha256: createHash("sha256").update("\x1b[13u").digest("hex"),
    });
    for (const wrongTail of [
      Buffer.from([4, 4]),
      Buffer.from("/exit\r"),
      Buffer.from("/exit\x1b[13u"),
    ]) {
      const wrongExitInput = Buffer.concat([
        Buffer.from(scenario.terminalInputBase64, "base64").subarray(0, -22),
        wrongTail,
      ]);
      expect(() =>
        compileInteractivePtyActions(
          {
            ...scenario,
            terminalInputBase64: wrongExitInput.toString("base64"),
            postCompletionInputByteLength: wrongTail.byteLength,
          },
          Buffer.concat([Buffer.from(`${challenge}\n`), wrongExitInput]),
        ),
      ).toThrow("integration.manifest.interaction");
    }
    expect(actions[2]).toEqual({
      action: "checkpoint-process-topology",
      topology: "root-with-contained-process-set",
    });
    const source = readFileSync(
      resolve(integrationRoot, scenario.scenarioProcess.path),
      "utf8",
    );
    const dropperSource = readFileSync(
      resolve(integrationRoot, "codex-candidate-dropper.mjs"),
      "utf8",
    );
    expect(
      scenario.runtimeArtifacts.filter(
        ({ destination }) => destination === "codex-candidate-dropper.mjs",
      ),
    ).toEqual([
      {
        source: { kind: "integration", path: "codex-candidate-dropper.mjs" },
        destination: "codex-candidate-dropper.mjs",
        sha256: createHash("sha256").update(dropperSource).digest("hex"),
      },
    ]);
    const candidateExec = dropperSource.indexOf("process.execve(\n");
    for (const denial of [
      'readdirSync("/control/private")',
      'readdirSync("/ledger")',
      "readdirSync(`/proc/${controllerPid}/fd`)",
      'process.kill(controllerPid, "SIGUSR2")',
      "checkpoint-${runId}.json",
      'createConnection({ path: "/control/private/gate.sock" })',
    ]) {
      expect(dropperSource.indexOf(denial)).toBeGreaterThan(-1);
      expect(dropperSource.indexOf(denial)).toBeLessThan(candidateExec);
    }
    // The controller remains root for /control/private, but the installed
    // product and its private Codex home must belong to the eventual UID 1000
    // candidate. Root-owned 0700 hooks/config made the real TUI exit before
    // the protected process-topology checkpoint.
    for (const literal of [
      "AGENTSCOPE_CANDIDATE_RUN_ID: integrationRunId,",
      "...(options.candidatePrincipal === true ? { uid: 1000, gid: 1000 } : {}),",
      "...options,\n      env: {\n        ...process.env,",
      'NODE_EXTRA_CA_CERTS: "/opt/agentscope/collector-ca.pem",\n      },\n      candidatePrincipal: true,',
      '["harness", "status", "codex", "--output", "json"],\n    { candidatePrincipal: true },',
      "fchownSync(codexDiagnosticLogDirectoryDescriptor, 1000, 1000);",
      "fchownSync(configurationDescriptor, 1000, 1000);",
    ])
      expect(source).toContain(literal);
    expect(source).toContain('from "./codex-trace-child-diagnostics.mjs"');
    expect(source).toContain("encodeAdapterReportedFailureMarker(");
    // CAP_CHOWN is admitted but CAP_FOWNER is not: chmod must precede the
    // ownership handoff, with the same final inode proof afterward.
    const configMode = source.indexOf(
      "fchmodSync(configurationDescriptor, 0o600);",
    );
    const configOwner = source.indexOf(
      "fchownSync(configurationDescriptor, 1000, 1000);",
    );
    const configFinalProof = source.indexOf(
      "const after = fstatSync(configurationDescriptor);",
      configOwner,
    );
    expect(configMode).toBeGreaterThan(
      source.indexOf('recordCandidateConfigStage("prove");'),
    );
    expect(configOwner).toBeGreaterThan(configMode);
    expect(configFinalProof).toBeGreaterThan(configOwner);
    for (const literal of [
      "fchownSync(ledgerDescriptor, 0, 0);",
      "fchmodSync(ledgerDescriptor, 0o700);",
      'ledger !== "/ledger"',
    ])
      expect(source).toContain(literal);
    expect(source.indexOf("fchmodSync(ledgerDescriptor, 0o700);")).toBeLessThan(
      source.indexOf('recordInteractivePhase("init")'),
    );
    for (const stage of [
      "closed-marker",
      "render",
      "create",
      "open",
      "prove",
      "publish",
    ])
      expect(source).toContain(`recordCandidateConfigStage("${stage}");`);
    for (const literal of [
      "candidateConfigStage = undefined;",
      "codexHomeStatus.uid !== 1000",
      "hookStatus.uid !== 1000",
      "launcherStatus.uid !== 1000",
      "(hookStatus.mode & 0o7777) !== 0o600",
      "(launcherStatus.mode & 0o7777) !== 0o700",
    ])
      expect(source).toContain(literal);
    expect(dropperSource).toContain(
      "process.setgid(1000);\nprocess.setuid(1000);",
    );
    const challengeRead = source.indexOf(
      "const readinessChallenge = await readReadinessChallenge();\n",
    );
    const codexLaunch = source.indexOf("  const codexRun = run(\n");
    const readinessChallengePublication = source.indexOf(
      "AGENTSCOPE_PTY_READY:${readinessChallenge}",
    );
    const freshSessionHome = source.indexOf(
      "readCodexSessionLedgerRecords(homeDescriptor).length !== 0",
    );
    const explicitHookEnablement = dropperSource.indexOf(
      '    "--enable",\n    "hooks",\n',
    );
    const explicitHookTrust = dropperSource.indexOf(
      '    "--dangerously-bypass-hook-trust",\n',
    );
    const modelRequest = source.indexOf(
      "  const modelRequests = await readTerminalModelRequests();\n",
    );
    const traceDeadline = source.indexOf(
      "  const traceDeadline = deadline - 3_000;\n",
      challengeRead,
    );
    const terminalWait = source.indexOf(
      "  ({ turnId: codexTurnId, records: codexTerminalLedger } =\n    await waitForCodexTurnTerminal(traceDeadline));\n",
      codexLaunch,
    );
    const checkpointAcknowledgement = source.indexOf(
      "    await Promise.race([checkpointWitness, earlyCodexExit]);\n",
      codexLaunch,
    );
    const checkpointWait = source.indexOf(
      "  const checkpointWitness = waitForCheckpointWitness();\n",
    );
    const terminalObserver = source.slice(
      source.indexOf("const waitForCodexTurnTerminal ="),
      source.indexOf("const waitForCodexStopBeforeExit ="),
    );
    const metadataBaseline = terminalObserver.indexOf(
      "recordModelBaseline(records);",
    );
    const terminalLedgerRead = terminalObserver.indexOf(
      "const records = readCodexSessionLedgerRecords(homeDescriptor);",
    );
    const codexJoin = source.indexOf(
      "  await observeBeforeDiagnosticDeadline(codexRun, traceDeadline);\n",
      codexLaunch,
    );
    const traceQueryAfterJoin = source.indexOf(
      "  const translated = translateCodexNativeObservations({\n",
      terminalWait,
    );
    expect(codexLaunch).toBeGreaterThan(-1);
    expect(freshSessionHome).toBeGreaterThan(-1);
    expect(freshSessionHome).toBeLessThan(codexLaunch);
    expect(challengeRead).toBeGreaterThan(-1);
    expect(challengeRead).toBeLessThan(codexLaunch);
    expect(readinessChallengePublication).toBeGreaterThan(challengeRead);
    expect(readinessChallengePublication).toBeLessThan(codexLaunch);
    expect(source).toContain(
      "`AGENTSCOPE_PTY_READY:${readinessChallenge}\\r\\n`",
    );
    expect(source).not.toContain(
      "`\\u001b[?1049hAGENTSCOPE_PTY_READY:${readinessChallenge}",
    );
    expect(codexLaunch).toBeLessThan(checkpointAcknowledgement);
    expect(checkpointWait).toBeGreaterThan(codexLaunch);
    expect(checkpointWait).toBeLessThan(checkpointAcknowledgement);
    expect(checkpointAcknowledgement).toBeLessThan(modelRequest);
    expect(terminalWait).toBeLessThan(modelRequest);
    expect(codexJoin).toBeLessThan(modelRequest);
    expect(source).not.toContain("waitForModelRequestBeforeDeadline");
    expect(source.slice(checkpointAcknowledgement, terminalWait)).not.toContain(
      "recordModelBaseline(",
    );
    expect(terminalLedgerRead).toBeGreaterThan(
      terminalObserver.indexOf("if (bootNow() >= traceDeadline)"),
    );
    expect(terminalLedgerRead).toBeGreaterThan(-1);
    expect(metadataBaseline).toBeGreaterThan(terminalLedgerRead);
    expect(metadataBaseline).toBeLessThan(
      terminalObserver.indexOf("codexTurnTerminalIdAfterBaseline("),
    );
    expect(source).not.toContain(
      "inspectCodexSessionStartBeforeFirstModelRequestAdmission",
    );
    expect(source).not.toContain("      prompt,\n");
    for (const literal of [
      "const expectedAssistantMessage = `AGENTSCOPE_CODEX_RESPONSE:${readinessChallenge}`;",
      "terminalCompletionMarker = `AGENTSCOPE_PTY_COMPLETE:${readinessChallenge}`;",
      'body.replace("AGENTSCOPE_PTY_COMPLETE", expectedAssistantMessage)',
      "baseUrl: `${modelEndpoint}/v1`,",
      "codexLedgerBaseline = [{ ...records[0], content: prefix }];",
    ])
      expect(source).toContain(literal);
    expect(source).not.toContain("readFileSync(`/proc/${pid}/stat`");
    expect(source).not.toContain('readdirSync("/proc"');
    for (const literal of [
      "const checkpointWitness = waitForCheckpointWitness();",
      'recordInteractivePhase("tui-child-rejected");\n      throw new Error("integration.codex.tui-child-rejected");',
      'preCheckpointFailureDiagnostic = `integration.fixture.codex-${kind}`;\n  writeFileSync(\n    join(ledger, "interactive-failure.txt"),\n    `${preCheckpointFailureDiagnostic}\\n`,\n    { flag: "wx", mode: 0o600 },\n  );',
    ])
      expect(source).toContain(literal);
    expect(source).not.toContain('process.once("SIGUSR2", onSignal);');
    expect(explicitHookEnablement).toBeGreaterThan(-1);
    expect(explicitHookTrust).toBeGreaterThan(-1);
    expect(explicitHookEnablement).toBeLessThan(explicitHookTrust);
    for (const literal of [
      "decodeCodexJoinDeadlineExitCode(exitCode) ??",
      "codexProjectionFailureDiagnostic(error?.message)",
      "codexUninstallFailureDiagnostic(error?.message)",
      "const ownedDiagnostic =\n    preCheckpointFailureDiagnostic ??\n    candidateConfigDiagnostic ??\n    postTraceFailureDiagnostic(error);",
      'if (interactiveFailurePhase === "verify-projection")',
      'if (interactiveFailurePhase === "verify-uninstall")',
      "if (ledger !== undefined && preCheckpointFailureDiagnostic === undefined)",
      ": `integration.fixture.codex-${interactiveFailurePhase}`);",
      "`${diagnostic}\\n`",
      "exitCode = 64 + interactiveFailurePhaseIndex;",
      "encodeCodexJoinDeadlineExitCode(",
      'if (worktree !== "/worktree")\n  throw new Error("integration.codex.environment-AGENTSCOPE_WORKTREE");',
      "value.discovery.configurationLocationCount !== 2",
      '[projects."/worktree"]\\ntrust_level = "trusted"\\n',
    ])
      expect(source).toContain(literal);
    expect(source).not.toContain(
      'if (interactiveFailurePhase === "verify-trace-get")',
    );
    expect(source).not.toContain(
      "classifyCodexTraceGetFailure(error?.message)",
    );
    const rootLogDirectory = source.indexOf(
      "const configuration = `log_dir = ${JSON.stringify(codexDiagnosticLogDirectory)}\\n${createCodexInternalProviderConfiguration(",
    );
    const providerConfiguration = source.indexOf(
      "    baseUrl: `${modelEndpoint}/v1`,",
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
    expect(traceTerminalPhase).toBeLessThan(modelRequest);
    expect(terminalWait).toBeLessThan(traceTerminalPhase);
    expect(traceTerminalPhase).toBeLessThan(codexJoin);
    expect(codexJoin).toBeLessThan(traceSettlementPhase);
    expect(traceSettlementPhase).toBeLessThan(traceQueryAfterJoin);
    expect(traceSearchPhase).toBe(-1);
    expect(traceSearchResultPhase).toBe(-1);
    expect(source).toContain(
      "if (!/\\/agentscope-hook-v1-[a-f0-9]{64}-d5000$/u.test(launcher))",
    );
    expect(source).not.toContain("runDirectHookProbe");
    expect(source).not.toContain("options.input");
    expect(source).not.toContain("readHookOperationalHealth");
    for (const literal of [
      "localSqliteAcceptanceBaseline",
      "classifyLocalSqliteOutcomeAfterBaseline",
      "openOperationalStateHealth",
      "const waitForTraceSummary =",
      'parseMachine(stdout, "agentscope traces search")',
    ])
      expect(source).not.toContain(literal);
    expect(source).toContain(
      "const evidence = correlateCodexNativeObservations(",
    );
    const outer = readFileSync(
      resolve(integrationRoot, "run-scenarios.mjs"),
      "utf8",
    );
    expect(outer).toMatch(/observeSelectedWriterOtlp\(\s*batches\[0\],/u);
    expect(outer).toContain(
      "canonicalGraphDigest: observed.transport.graphSha256",
    );
    expect(outer).not.toContain("canonicalGraph: observed.graph");
    const terminalCompletion = source.indexOf(
      "`\\u001b]2;${terminalCompletionMarker}\\u001b\\\\`",
      terminalWait,
    );
    expect(terminalCompletion).toBeGreaterThan(terminalWait);
    expect(terminalCompletion).toBeLessThan(codexJoin);
    const stopBeforeExit = source.indexOf(
      "  await waitForCodexStopBeforeExit(traceDeadline);\n",
      traceTerminalPhase,
    );
    expect(stopBeforeExit).toBeGreaterThan(traceTerminalPhase);
    expect(stopBeforeExit).toBeLessThan(terminalCompletion);
    const stopWait = source.slice(
      source.indexOf("const waitForCodexStopBeforeExit ="),
      source.indexOf("const waitForTraceObservation ="),
    );
    expect(stopWait).toContain("codexStopHookReadyForExit(state)");
    expect(stopWait).toContain("deadline: traceDeadline,");
    expect(stopWait).toContain("maximumWaitMilliseconds: 20,");
    const postJoinDeadline = source.indexOf(
      "  recordTerminalObservationBeforeDeadline({\n",
      codexJoin,
    );
    expect(postJoinDeadline).toBeGreaterThan(codexJoin);
    expect(postJoinDeadline).toBeLessThan(traceSettlementPhase);
    expect(source).not.toContain("const waitForTraceSettlement =");
    for (const literal of [
      "  await publishTerminalCompletionBeforeDeadline({",
      '            child.kill("SIGKILL");\n',
      "      if (timer !== undefined) clearTimeout(timer);\n",
    ])
      expect(source).toContain(literal);
    expect(modelRequest).toBeGreaterThan(checkpointAcknowledgement);
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
      '  const encodedEvidence = Buffer.from(\n    JSON.stringify({ ...evidence, mockServerTraffic: upstreamTraffic }),\n  ).toString("base64url");\n',
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
    expect(checkpointAcknowledgement).toBeGreaterThan(codexLaunch);
    expect(modelRequest).toBeGreaterThan(checkpointAcknowledgement);
    expect(metadataBaseline).toBeGreaterThan(-1);
    expect(codexJoin).toBeLessThan(modelRequest);
    expect(traceQueryAfterJoin).toBeGreaterThan(codexJoin);
    const configureUpstream = source.indexOf(
      "  await configureModelGate(preparationCutoff, traceDeadline);\n",
    );
    expect(configureUpstream).toBeGreaterThan(-1);
    expect(configureUpstream).toBeLessThan(codexLaunch);
    expect(source.match(/AGENTSCOPE_PTY_READY/gu)).toHaveLength(1);
    expect(source).not.toContain("AGENTSCOPE_PTY_TOPOLOGY");
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
    expect(codex.mockServerImage).toBe(codex.image);
    expect(
      manifest.scenarios.every(
        (scenario) => scenario.mockServerImage === codex.image,
      ),
    ).toBe(true);
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
    const claude = manifest.scenarios.find(
      ({ scenarioId }) => scenarioId === "claude-interactive-trace-smoke",
    )!;
    const signed = manifest.evidence.find(
      ({ evidenceId }) => evidenceId === claude.harnessEvidenceId,
    )!.material;
    expect(signed.kind).toBe("signed-release-manifest");
    if (signed.kind !== "signed-release-manifest")
      throw new Error("test.material");
    expect(signed.verifierImage).toBe(codex.image);
    expect(signed.verifierImage).not.toBe(material.verifierImage);
    expect(capabilityScenarioImages(manifest, [claude.scenarioId])).toEqual(
      [
        ...new Set([
          claude.image,
          claude.mockServerImage,
          signed.verifierImage,
        ]),
      ].sort(),
    );
    expect(capabilityScenarioImages(manifest, [codex.scenarioId])).toEqual(
      [
        ...new Set([
          codex.image,
          codex.mockServerImage,
          material.verifierImage,
        ]),
      ].sort(),
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
});

describe("integration npm material policy", () => {
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
      { index: 0, total: compiled.scenarios.length + 1 },
    ])
      expect(() => selectCapabilityScenarios(compiled, { shard })).toThrow(
        "integration.manifest.shard",
      );
  });
});
