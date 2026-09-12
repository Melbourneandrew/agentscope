import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  certificationFailureAuthorityIsValid,
  compileSubstrateCertificationReceipt,
  leakedChildContainmentWasObserved,
  parseSubstrateCertificationRequest,
  providerCredentialEnvironmentIsClear,
  requireThreeMatchingCertificationReceipts,
  SUBSTRATE_CERTIFICATION_CASES,
  SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES,
} from "./substrate-certification.js";

const projection = {
  candidateBundleIdentity: `sha256-${"a".repeat(64)}`,
  manifestIdentity: `sha256-${"b".repeat(64)}`,
  selectedScenarioIds: ["fixture-process-smoke"],
  scenarioResults: [
    {
      cleanup: "complete" as const,
      outcome: "passed" as const,
      scenarioId: "fixture-process-smoke",
    },
  ],
  selectionIdentity: `sha256:${"c".repeat(64)}`,
};

describe("substrate certification request", () => {
  it("accepts only closed GitHub-hosted lifecycle requests", () => {
    expect(
      parseSubstrateCertificationRequest(
        { AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY: "1" },
        "github-hosted",
        "lifecycle",
      ),
    ).toEqual({ kind: "replay", ordinal: 1 });
    for (const certificationCase of SUBSTRATE_CERTIFICATION_CASES)
      expect(
        parseSubstrateCertificationRequest(
          { AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: certificationCase },
          "github-hosted",
          "lifecycle",
        ),
      ).toEqual({ case: certificationCase, kind: "negative" });
    for (const [environment, hostKind, mode] of [
      [
        { AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY: "4" },
        "github-hosted",
        "lifecycle",
      ],
      [
        { AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "other" },
        "github-hosted",
        "lifecycle",
      ],
      [
        { AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY: "1" },
        "crabbox",
        "crabbox",
      ],
      [
        {
          AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: "wrong-argv",
          AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY: "1",
        },
        "github-hosted",
        "lifecycle",
      ],
    ] as const)
      expect(() =>
        parseSubstrateCertificationRequest(environment, hostKind, mode),
      ).toThrow("integration.certification.request");
  });

  it("fails closed on hostile request accessors", () => {
    const environment = Object.defineProperty(
      {},
      "AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE",
      { get: () => "wrong-argv" },
    );
    expect(() =>
      parseSubstrateCertificationRequest(
        environment,
        "github-hosted",
        "lifecycle",
      ),
    ).toThrow("integration.certification.request");
  });

  it("binds every controlled case to one exact terminal primary failure", () => {
    expect(
      Object.keys(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES).sort(),
    ).toEqual([...SUBSTRATE_CERTIFICATION_CASES].sort());
    expect(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES["wrong-argv"]).toBe(
      "integration.controller.unsettled-operation",
    );
    expect(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES["leaked-child"]).toBe(
      "integration.controller.unsettled-operation",
    );
    expect(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES["false-success"]).toBe(
      "integration.certification.false-success",
    );
  });
});

describe("leaked-child causal observation", () => {
  const observed = (replacement: Record<string, unknown> = {}) =>
    leakedChildContainmentWasObserved({
      certificationReadiness: {
        readinessVersion: 1,
        certificationCase: "leaked-child",
        challengeSha256: `sha256:${"a".repeat(64)}`,
      },
      cleanup: "clean",
      fixtureCaptured: true,
      fixtureResultStatus: "complete",
      residualProcessCount: 0,
      ...replacement,
    });

  it("requires exact fixture readiness lineage and terminal containment", () => {
    expect(observed()).toBe(true);
    for (const replacement of [
      { certificationReadiness: null },
      {
        certificationReadiness: {
          readinessVersion: 1,
          certificationCase: "other",
          challengeSha256: `sha256:${"a".repeat(64)}`,
        },
      },
      {
        certificationReadiness: {
          readinessVersion: 1,
          certificationCase: "leaked-child",
          challengeSha256: "sha256:substituted",
        },
      },
      { fixtureCaptured: false },
      { fixtureResultStatus: "partial" },
      { fixtureResultStatus: "complete-substituted" },
      { cleanup: "failed" },
      { residualProcessCount: 1 },
    ])
      expect(observed(replacement)).toBe(false);
  });
});

describe("certification failure cleanup authority", () => {
  const readiness = {
    readinessVersion: 1,
    certificationCase: "leaked-child",
    challengeSha256: `sha256:${"a".repeat(64)}`,
  };
  const record = (replacement: Record<string, unknown> = {}) => ({
    certificationCase: "leaked-child",
    certificationPredicate: "containment-intervention",
    certificationReadiness: readiness,
    primaryFailure: "integration.controller.unsettled-operation",
    ...replacement,
  });

  it("accepts current records and rejects missing or substituted readiness", () => {
    expect(certificationFailureAuthorityIsValid(record())).toBe(true);
    expect(
      certificationFailureAuthorityIsValid(
        record({ certificationReadiness: null }),
      ),
    ).toBe(false);
    expect(
      certificationFailureAuthorityIsValid(
        record({
          certificationReadiness: {
            ...readiness,
            challengeSha256: "sha256:substituted",
          },
        }),
      ),
    ).toBe(false);
    expect(
      certificationFailureAuthorityIsValid(
        record({ primaryFailure: "integration.certification.leaked-child" }),
      ),
    ).toBe(false);
  });
});

describe("credential environment closure", () => {
  it("rejects provider credentials without reading their content", () => {
    expect(providerCredentialEnvironmentIsClear({ PATH: "/usr/bin" })).toBe(
      true,
    );
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AZURE_OPENAI_API_KEY",
      "CLAUDE_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CRABBOX_COORDINATOR_TOKEN",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "HCLOUD_TOKEN",
      "HETZNER_TOKEN",
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
      "OPENAI_API_KEY",
    ]) {
      expect(providerCredentialEnvironmentIsClear({ [name]: "canary" })).toBe(
        false,
      );
      expect(providerCredentialEnvironmentIsClear({ [name]: "" })).toBe(false);
      expect(
        providerCredentialEnvironmentIsClear(
          Object.defineProperty({}, name, {
            enumerable: true,
            get: () => {
              throw new Error("CALLER-CONTENT-CANARY");
            },
          }),
        ),
      ).toBe(false);
    }
    expect(
      providerCredentialEnvironmentIsClear({
        AGENTSCOPE_VALIDATION_LEASE_TOKEN: "controller-owned",
      }),
    ).toBe(true);
    expect(
      providerCredentialEnvironmentIsClear({ UNLISTED_VENDOR_TOKEN: "x" }),
    ).toBe(false);
  });
});

describe("substrate certification receipts", () => {
  it("requires exactly three matching stable identity projections", () => {
    const receipts = ([1, 2, 3] as const).map((replayOrdinal) =>
      compileSubstrateCertificationReceipt({
        githubSha: "d".repeat(40),
        projection,
        replayOrdinal,
      }),
    );
    expect(requireThreeMatchingCertificationReceipts(receipts)).toEqual(
      receipts[0],
    );
    expect(() =>
      requireThreeMatchingCertificationReceipts(receipts.slice(0, 2)),
    ).toThrow("integration.certification.fan-in");
    expect(() =>
      requireThreeMatchingCertificationReceipts([
        receipts[0],
        receipts[1],
        { ...receipts[2], manifestIdentity: `sha256-${"e".repeat(64)}` },
      ]),
    ).toThrow("integration.certification.receipt");
  });

  it("rejects forged authority labels, extra keys, and scenario reorder", () => {
    const receipt = compileSubstrateCertificationReceipt({
      githubSha: "d".repeat(40),
      projection: {
        ...projection,
        selectedScenarioIds: ["fixture-process-smoke", "fixture-process-z"],
        scenarioResults: [
          ...projection.scenarioResults,
          {
            cleanup: "complete" as const,
            outcome: "passed" as const,
            scenarioId: "fixture-process-z",
          },
        ],
      },
      replayOrdinal: 1,
    });
    expect(() =>
      requireThreeMatchingCertificationReceipts([
        { ...receipt, evidenceAuthority: "support" },
        { ...receipt, replayOrdinal: 2 },
        { ...receipt, replayOrdinal: 3 },
      ]),
    ).toThrow("integration.certification.receipt");
    expect(() =>
      requireThreeMatchingCertificationReceipts([
        { ...receipt, extra: true },
        { ...receipt, replayOrdinal: 2 },
        { ...receipt, replayOrdinal: 3 },
      ]),
    ).toThrow("integration.certification.receipt");
    expect(() =>
      compileSubstrateCertificationReceipt({
        githubSha: "d".repeat(40),
        projection: {
          ...projection,
          selectedScenarioIds: ["fixture-process-z", "fixture-process-smoke"],
          scenarioResults: [
            ...projection.scenarioResults,
            {
              cleanup: "complete" as const,
              outcome: "passed" as const,
              scenarioId: "fixture-process-z",
            },
          ],
        },
        replayOrdinal: 1,
      }),
    ).toThrow("integration.certification.projection");
  });
});

describe("controlled descendant fixture", () => {
  it("publishes causal readiness, survives TERM, and is terminally joined", async () => {
    if (process.platform === "win32") return;
    const token = "a".repeat(32);
    const child = spawn(
      process.execPath,
      [
        resolve(
          import.meta.dirname,
          "../fixtures/substrate-negative-process.mjs",
        ),
        "leaked-child",
        token,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      child.stdout.setEncoding("utf8");
      const expected = `AGENTSCOPE_NEGATIVE_READY=${token}\n`;
      await new Promise<void>((resolveReady, rejectReady) => {
        let received = "";
        const settle = (error?: Error) => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("error", onError);
          child.off("exit", onExit);
          if (error === undefined) resolveReady();
          else rejectReady(error);
        };
        const onData = (chunk: string) => {
          received += chunk;
          if (received === expected) settle();
          else if (!expected.startsWith(received))
            settle(new Error("integration.fixture.negative-readiness"));
        };
        const onError = () => {
          settle(new Error("integration.fixture.negative-readiness"));
        };
        const onExit = () => {
          settle(new Error("integration.fixture.negative-readiness"));
        };
        const timer = setTimeout(onError, 2_000);
        child.stdout.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
      });
      process.kill(-child.pid!, "SIGTERM");
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      process.kill(-child.pid!, "SIGKILL");
      await once(child, "exit");
      expect(() => process.kill(child.pid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The exact process group is already absent.
      }
    }
  });
});
