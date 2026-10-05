import { describe, expect, it } from "vitest";
import { inferModeAndIdentity } from "./controller-host-identity.js";
import {
  parseMockServerResearchRequest,
  mockServerResearchStopFitsTerminalObservation,
} from "./mockserver-research-request.js";

const revision = "a".repeat(40);
const environment = (): NodeJS.ProcessEnv => ({
  AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier",
  AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS: "123456789",
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_NAME: "synthetic-runner",
  GITHUB_JOB: "mockserver-supplier-research",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "example/agentscope",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: revision,
  GITHUB_WORKFLOW_SHA: revision,
  GITHUB_WORKFLOW_REF:
    "example/agentscope/.github/workflows/integration.yml@refs/heads/main",
});
const parse = (input: NodeJS.ProcessEnv) =>
  parseMockServerResearchRequest(input, "github-hosted", "lifecycle");

describe("closed manual MockServer research request", () => {
  it("snapshots one exact source/workflow/run request as immutable data", () => {
    const input = environment();
    const request = parse(input);
    input.GITHUB_RUN_ID = "456";
    expect(request).toEqual({
      kind: "supplier",
      repository: "example/agentscope",
      revision,
      runId: "123",
      attempt: "1",
      workflowRevision: revision,
      workflowRef:
        "example/agentscope/.github/workflows/integration.yml@refs/heads/main",
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("does not reinterpret ordinary dispatch or certification requests", () => {
    const input = environment();
    Reflect.deleteProperty(input, "AGENTSCOPE_MOCKSERVER_RESEARCH");
    input.AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY = "1";
    input.AGENTSCOPE_INTEGRATION_SHARD = "0/1";
    expect(parse(input)).toEqual({ kind: "none" });
    expect(parseMockServerResearchRequest({}, "crabbox", "crabbox")).toEqual({
      kind: "none",
    });
  });

  it.each([
    "AGENTSCOPE_INTEGRATION_SCENARIO",
    "AGENTSCOPE_INTEGRATION_SHARD",
    "AGENTSCOPE_INTEGRATION_FULL",
    "AGENTSCOPE_INTEGRATION_HARNESS",
    "AGENTSCOPE_INTEGRATION_TAG",
    "AGENTSCOPE_INTEGRATION_TEST_MODE",
    "AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY",
    "AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE",
  ])("rejects a conflicting selector even when empty: %s", (name) => {
    for (const value of ["", "0/1", "synthetic"])
      expect(() => parse({ ...environment(), [name]: value })).toThrow(
        "research-request",
      );
  });

  it.each([
    ["AGENTSCOPE_MOCKSERVER_RESEARCH", ""],
    ["AGENTSCOPE_MOCKSERVER_RESEARCH", "latest"],
    ["GITHUB_ACTIONS", "false"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_JOB", "hermetic-platform"],
    ["GITHUB_REPOSITORY", "../example"],
    ["GITHUB_SHA", "A".repeat(40)],
    ["GITHUB_WORKFLOW_SHA", "b".repeat(40)],
    [
      "GITHUB_WORKFLOW_REF",
      "example/agentscope/.github/workflows/other.yml@refs/heads/main",
    ],
    [
      "GITHUB_WORKFLOW_REF",
      "example/agentscope/.github/workflows/integration.yml@refs/tags/v1",
    ],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ID", "01"],
    ["GITHUB_RUN_ATTEMPT", "1000000"],
  ])("rejects mismatched provenance %s=%s", (name, value) => {
    expect(() => parse({ ...environment(), [name]: value })).toThrow(
      "research-request",
    );
  });

  it("rejects incompatible controller locations and modes", () => {
    for (const mode of ["candidate", "crabbox"] as const)
      expect(() =>
        parseMockServerResearchRequest(environment(), "github-hosted", mode),
      ).toThrow("research-request");
    expect(() =>
      parseMockServerResearchRequest(environment(), "crabbox", "lifecycle"),
    ).toThrow("research-request");
  });

  it("rejects proxy and accessor environment records without invoking them", () => {
    let reads = 0;
    const accessor = Object.defineProperty(environment(), "GITHUB_SHA", {
      get: () => {
        reads += 1;
        return revision;
      },
    });
    const proxy = new Proxy(environment(), {
      getOwnPropertyDescriptor: () => {
        reads += 1;
        throw Error("synthetic");
      },
    });
    for (const input of [accessor, proxy])
      expect(() => parse(input)).toThrow("research-request");
    expect(reads).toBe(0);
  });
});

describe("unchanged disposable-host classification", () => {
  it("retains the selected GitHub lifecycle and candidate identities", () => {
    const input = environment();
    const lifecycle = inferModeAndIdentity(input);
    expect(lifecycle.hostKind).toBe("github-hosted");
    expect(lifecycle.mode).toBe("lifecycle");
    expect(lifecycle.identity.GITHUB_SHA).toBe(revision);
    expect(Object.isFrozen(lifecycle.identity)).toBe(true);
    expect(
      inferModeAndIdentity({
        ...input,
        AGENTSCOPE_INTEGRATION_MODE: "candidate",
      }).mode,
    ).toBe("candidate");
  });

  it("retains the bounded Crabbox identity and rejects workstation fallback", () => {
    expect(
      inferModeAndIdentity({
        AGENTSCOPE_INTEGRATION_EXECUTOR: "crabbox",
        CRABBOX_LEASE_ID: "cbx_synthetic",
        CRABBOX_RUN_ID: "run_synthetic",
        CRABBOX_SLUG: "example/fixture",
      }),
    ).toEqual({
      hostKind: "crabbox",
      mode: "crabbox",
      identity: {
        CRABBOX_LEASE_ID: "cbx_synthetic",
        CRABBOX_RUN_ID: "run_synthetic",
        CRABBOX_SLUG: "example/fixture",
      },
    });
    expect(() => inferModeAndIdentity({})).toThrow("disposable-host-required");
    expect(() =>
      inferModeAndIdentity({ ...environment(), GITHUB_SHA: "bad" }),
    ).toThrow("disposable-host-identity");
  });
});

describe("research stop terminal filter", () => {
  const terminal = {
    code: 3,
    signal: null,
    contained: true,
    residualWorkObserved: false,
    terminationInitiated: false,
    completedWithinDeadline: true,
  };
  it("requires all settled observations, not merely exit3 or receipt presence", () => {
    expect(mockServerResearchStopFitsTerminalObservation(terminal)).toBe(true);
    for (const changed of [
      { code: 1 },
      { signal: "SIGTERM" },
      { contained: false },
      { residualWorkObserved: true },
      { terminationInitiated: true },
      { completedWithinDeadline: false },
    ])
      expect(
        mockServerResearchStopFitsTerminalObservation({
          ...terminal,
          ...changed,
        }),
      ).toBe(false);
    expect(mockServerResearchStopFitsTerminalObservation({ code: 3 })).toBe(
      false,
    );
  });
  it("does not consult hostile getters or error-message lookalikes", () => {
    let reads = 0;
    const accessor = Object.defineProperty({ ...terminal }, "code", {
      get: () => {
        reads += 1;
        return 3;
      },
    });
    for (const input of [
      accessor,
      new Proxy(terminal, {}),
      Error("research-complete"),
    ])
      expect(mockServerResearchStopFitsTerminalObservation(input)).toBe(false);
    expect(reads).toBe(0);
  });
});
