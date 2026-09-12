import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- checksum-bound runtime modules intentionally expose no TypeScript API */

// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { correlateCodexPlatformObservations } from "../codex-platform-oracle.mjs";
// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { translateCodexPlatformObservations } from "../fixtures/codex-platform-adapter.mjs";

const traceId = "0123456789abcdef0123456789abcdef";
const promptSha256 =
  "8fa471336a2b22881c19fc825a447c7f6c16c6f38ed937f7c0ecdf15d858276c";
const raw = () => ({
  scenarioId: "codex-tui-trace-smoke",
  modelRequest: {
    bodyBytes: 128,
    bodySha256: "a".repeat(64),
    credentialHeaderCount: 0,
    method: "POST",
    path: "/v1/responses",
    promptOccurrenceCount: 1,
    promptSha256,
  },
  search: { completion: "complete", harness: "codex", spanCount: 3, traceId },
  retrieval: {
    completion: "complete",
    parentLinked: true,
    resourceSpanCount: 1,
    spanNames: ["codex.turn", "codex.response"],
    traceId,
  },
  doctor: { completion: "complete", errors: 0, findingCount: 12, warnings: 1 },
  uninstall: {
    completion: "complete",
    installedStatus: {
      installation: "unchanged",
      configurationPresentCount: 1,
    },
    uninstall: { disposition: "committed", changedTargetCount: 1 },
    uninstalledStatus: { installation: "ready", configurationPresentCount: 0 },
  },
});
type RawObservation = ReturnType<typeof raw>;
const correlate = (value = raw()) =>
  correlateCodexPlatformObservations(
    translateCodexPlatformObservations(value),
    {
      artifactFileName: "agentscope-cli-0.1.0.tgz",
      expectedPromptSha256: promptSha256,
      scenarioId: "codex-tui-trace-smoke",
    },
  );

describe("Codex PTY scenario observation boundary", () => {
  it("reduces exact loopback, trace, Doctor, and uninstall observations", () => {
    expect(correlate()).toMatchObject({
      resultStatus: "complete",
      lifecycle: [
        "install",
        "configure",
        "hook",
        "execute",
        "export",
        "retrieve",
        "uninstall",
      ],
      modelLedger: { entries: [{ path: "/v1/responses" }] },
      harnessObservation: {
        kind: "codex-tui-trace",
        modelRequestBodySha256: "a".repeat(64),
        traceId,
        spanNames: ["codex.turn", "codex.response"],
        parentLinked: true,
        doctorErrors: 0,
        uninstallDisposition: "committed",
      },
      destinationLedger: {
        retrieval: [{ operation: "search" }, { operation: "get" }],
      },
    });
  });

  it.each([
    [
      "credential header",
      (value: RawObservation) => {
        value.modelRequest.credentialHeaderCount = 1;
      },
    ],
    [
      "duplicate prompt",
      (value: RawObservation) => {
        value.modelRequest.promptOccurrenceCount = 2;
      },
    ],
    [
      "model path",
      (value: RawObservation) => {
        value.modelRequest.path = "/v1/chat";
      },
    ],
    [
      "model digest",
      (value: RawObservation) => {
        value.modelRequest.bodySha256 = "x";
      },
    ],
    [
      "missing trace",
      (value: RawObservation) => {
        value.search.spanCount = 0;
      },
    ],
    [
      "wrong harness",
      (value: RawObservation) => {
        value.search.harness = "claude";
      },
    ],
    [
      "trace substitution",
      (value: RawObservation) => {
        value.retrieval.traceId = "f".repeat(32);
      },
    ],
    [
      "empty graph",
      (value: RawObservation) => {
        value.retrieval.resourceSpanCount = 0;
      },
    ],
    [
      "unlinked graph",
      (value: RawObservation) => {
        value.retrieval.parentLinked = false;
      },
    ],
    [
      "Doctor failure",
      (value: RawObservation) => {
        value.doctor.errors = 1;
      },
    ],
    [
      "uninstall failure",
      (value: RawObservation) => {
        value.uninstall.uninstall.disposition = "rolled-back";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = raw();
    mutate(value);
    expect(() => correlate(value)).toThrow(
      "integration.codex.adapter-observation",
    );
  });

  it("rejects stimulus substitution independently of the adapter", () => {
    const observation = translateCodexPlatformObservations(raw());
    expect(() =>
      correlateCodexPlatformObservations(observation, {
        artifactFileName: "agentscope-cli-0.1.0.tgz",
        expectedPromptSha256: "0".repeat(64),
        scenarioId: "codex-tui-trace-smoke",
      }),
    ).toThrow("integration.codex.oracle-stimulus");
  });

  it("rejects a valid but substituted prompt digest after translation", () => {
    const value = raw();
    value.modelRequest.promptSha256 = "0".repeat(64);
    expect(() => correlate(value)).toThrow(
      "integration.codex.oracle-model-request",
    );
  });
});
