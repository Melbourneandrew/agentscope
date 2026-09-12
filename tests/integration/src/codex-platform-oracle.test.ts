import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- checksum-bound runtime modules intentionally expose no TypeScript API */

// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { correlateCodexPlatformObservations } from "../codex-platform-oracle.mjs";
// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { translateCodexPlatformObservations } from "../fixtures/codex-platform-adapter.mjs";

const traceId = "0123456789abcdef0123456789abcdef";
const promptSha256 =
  "8fa471336a2b22881c19fc825a447c7f6c16c6f38ed937f7c0ecdf15d858276c";
const hooks = ["SessionStart", "Stop", "SessionEnd"].map((event) => ({
  recordVersion: 1,
  event,
  sessionId: "session-1",
  turnId: event === "Stop" ? "turn-1" : null,
  model: event === "SessionEnd" ? null : "fixture-model",
  inputBytes: 128,
  inputSha256: "b".repeat(64),
  launcherPathSha256: "c".repeat(64),
  launcherSha256: "d".repeat(64),
  launcherMode: 0o755,
  launcherUid: 0,
  launcherGid: 0,
  launcherExitCode: 0,
  launcherStdoutBytes: 0,
  launcherStderrBytes: 0,
}));
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
  hooks: structuredClone(hooks),
  search: { completion: "complete", harness: "codex", spanCount: 3, traceId },
  retrieval: { completion: "complete", resourceSpanCount: 1, traceId },
  doctor: { completion: "complete" },
  uninstall: { completion: "complete" },
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

// eslint-disable-next-line max-lines-per-function -- closed adversarial observation matrix
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
        hookEvents: ["SessionStart", "Stop", "SessionEnd"],
        modelRequestBodySha256: "a".repeat(64),
        traceId,
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
      "hook reordering",
      (value: RawObservation) => {
        value.hooks.reverse();
      },
    ],
    [
      "hook session substitution",
      (value: RawObservation) => {
        value.hooks[2]!.sessionId = "session-2";
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
      "Doctor failure",
      (value: RawObservation) => {
        value.doctor.completion = "failed";
      },
    ],
    [
      "uninstall failure",
      (value: RawObservation) => {
        value.uninstall.completion = "failed";
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
