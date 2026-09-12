import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- checksum-bound runtime modules intentionally expose no TypeScript API */

// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { correlateCodexPlatformObservations } from "../codex-platform-oracle.mjs";
// @ts-expect-error checksum-bound runtime module intentionally has no TS API
import { translateCodexPlatformObservations } from "../fixtures/codex-platform-adapter.mjs";

const traceId = "0123456789abcdef0123456789abcdef";
const promptSha256 =
  "8fa471336a2b22881c19fc825a447c7f6c16c6f38ed937f7c0ecdf15d858276c";
const prompt = "Reply with one short confirmation and do not use tools.";
const raw = () => ({
  scenarioId: "codex-tui-trace-smoke",
  prompt,
  promptSha256,
  modelRequests: [
    {
      method: "POST",
      path: "/v1/responses",
      body: JSON.stringify({ model: "fixture-model", input: prompt }),
      headers: [] as Array<{ name: string }>,
    },
  ],
  search: { completion: "complete", harness: "codex", spanCount: 2, traceId },
  retrieval: {
    completion: "complete",
    modelName: "fixture-model",
    parentLinked: true,
    resourceSpanCount: 1,
    sessionId: "session-1",
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

// eslint-disable-next-line max-lines-per-function -- one matrix proves translation/oracle separation across every retained observation
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

  it("keeps expected success values out of the translation adapter", () => {
    const value = raw();
    value.modelRequests[0]!.path = "/unexpected";
    expect(
      translateCodexPlatformObservations(value).modelRequests[0].path,
    ).toBe("/unexpected");
    expect(() => correlate(value)).toThrow(
      "integration.codex.oracle-model-request",
    );
  });

  it("rejects late, duplicate, and contradictory terminal model records", () => {
    for (const extra of [
      { ...raw().modelRequests[0] },
      { ...raw().modelRequests[0], path: "/unexpected" },
    ] as Array<RawObservation["modelRequests"][number]>) {
      const value = raw();
      value.modelRequests.push(extra);
      expect(() => correlate(value)).toThrow(
        "integration.codex.oracle-model-request",
      );
    }
  });

  it("binds the stored hook trace model and nonempty session", () => {
    const mutations = [
      (value: RawObservation) => {
        value.retrieval.sessionId = "";
      },
      (value: RawObservation) => {
        value.retrieval.modelName = "other";
      },
    ];
    for (const mutate of mutations) {
      const value = raw();
      mutate(value);
      expect(() => correlate(value)).toThrow(/integration\.codex\.oracle-/u);
    }
  });

  it("rejects malformed native request bodies in the adapter", () => {
    const value = raw();
    value.modelRequests[0]!.body = "{";
    expect(() => translateCodexPlatformObservations(value)).toThrow(
      "integration.codex.adapter-observation",
    );
  });

  it.each([
    [
      "credential header",
      (value: RawObservation) => {
        value.modelRequests[0]!.headers = [{ name: "Authorization" }];
      },
    ],
    [
      "duplicate prompt",
      (value: RawObservation) => {
        value.modelRequests[0]!.body = JSON.stringify({
          model: "fixture-model",
          input: [prompt, prompt],
        });
      },
    ],
    [
      "model path",
      (value: RawObservation) => {
        value.modelRequests[0]!.path = "/v1/chat";
      },
    ],
    [
      "model identity",
      (value: RawObservation) => {
        value.modelRequests[0]!.body = JSON.stringify({
          model: "other",
          input: prompt,
        });
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
    expect(() => correlate(value)).toThrow(/integration\.codex\.oracle-/u);
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
    value.promptSha256 = "0".repeat(64);
    expect(() => correlate(value)).toThrow(
      "integration.codex.oracle-model-request",
    );
  });
});
