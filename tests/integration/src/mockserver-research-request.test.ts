import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { inferModeAndIdentity } from "./controller-host-identity.js";
import {
  parseMockServerResearchRequest,
  mockServerResearchStopFitsTerminalObservation,
} from "./mockserver-research-request.js";

type WorkflowStep = {
  uses?: string;
  name?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  if?: string;
  steps: WorkflowStep[];
  needs?: string | string[];
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("public research script terminal status", () => {
  it("measures the exact pnpm script/filter chain's synthetic exit status", () => {
    const root = realpathSync(
      mkdtempSync(resolve(tmpdir(), "agentscope-research-pnpm-")),
    );
    roots.push(root);
    mkdirSync(resolve(root, "integration"));
    writeFileSync(
      resolve(root, "pnpm-workspace.yaml"),
      "packages:\n  - integration\n",
    );
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          "test:integration":
            "pnpm --filter @agentscope/integration integration",
        },
      }),
    );
    writeFileSync(
      resolve(root, "integration/package.json"),
      JSON.stringify({
        name: "@agentscope/integration",
        version: "0.0.0",
        private: true,
        scripts: { integration: "node -e 'process.exit(3)'" },
      }),
    );
    let status: number | null = null;
    try {
      execFileSync("pnpm", ["test:integration"], {
        cwd: root,
        timeout: 10_000,
        stdio: "pipe",
      });
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(3);
  });
});
function assertImmutableResearchAncestors(jobs: Record<string, WorkflowJob>) {
  const visited = new Set<string>();
  const pending = ["mockserver-supplier-research"];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const ancestor = jobs[name]!;
    expect(ancestor).toBeDefined();
    for (const step of ancestor.steps)
      if (step.uses !== undefined)
        expect(step.uses).toMatch(
          /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+@[a-f0-9]{40}$/u,
        );
    const needs = ancestor.needs;
    pending.push(
      ...(needs === undefined
        ? []
        : typeof needs === "string"
          ? [needs]
          : needs),
    );
  }
  expect([...visited].sort()).toEqual([
    "mockserver-supplier-research",
    "prepare-candidate",
  ]);
}
describe("connected hosted supplier research boundary", () => {
  it("uses the real source stage but rejects a forged caller before reading its fields", () => {
    const modulePath = resolve(
      import.meta.dirname,
      "../mockserver-material/research-stage.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const {runMockServerResearchStage} = await import(${JSON.stringify(modulePath)});
      let read = false;
      const input = {get request(){read = true; throw new Error('hostile');}};
      try { await runMockServerResearchStage(input); process.exit(2); }
      catch (error) { console.log(JSON.stringify({code:error.message,read})); }
    `,
      ],
      { env: {}, encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "integration.outer-host.capability-required",
      read: false,
    });
  });
  it("keeps research manual-only and outside all ordinary certification jobs", () => {
    const value = parseYaml(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../.github/workflows/integration.yml",
        ),
        "utf8",
      ),
    ) as {
      on: {
        workflow_dispatch: { inputs: Record<string, Record<string, unknown>> };
      };
      jobs: Record<string, WorkflowJob>;
    };
    expect(value.on.workflow_dispatch.inputs.shard).not.toHaveProperty(
      "default",
    );
    expect(value.on.workflow_dispatch.inputs.mockserver_research).toMatchObject(
      { type: "boolean", default: false },
    );
    const job = value.jobs["mockserver-supplier-research"]!;
    expect(
      job.steps
        .filter(({ uses }) => uses !== undefined)
        .map(({ uses }) => uses),
    ).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.mockserver_research",
    );
    expect(job.needs).toBe("prepare-candidate");
    assertImmutableResearchAncestors(value.jobs);
    for (const name of [
      "hermetic-platform",
      "controlled-negative",
      "substrate-certification-fan-in",
    ])
      expect(value.jobs[name]!.if).toBe("${{ !inputs.mockserver_research }}");
    expect(value.jobs["hermetic-integration"]!.if).toBe(
      "always() && !inputs.mockserver_research",
    );
    expect(job.steps[0]!.run).toBe(
      'test -z "$REQUEST_SCENARIO"\ntest -z "$REQUEST_SHARD"\n',
    );
    const execution = job.steps.find(
      ({ name }) =>
        name ===
        "Require settled research stop and independently verified packet",
    )!;
    expect(execution.run).toMatch(
      /test "\$status" -eq 3\n[\s\S]*node tests\/integration\/verify-mockserver-research\.mjs\n/u,
    );
    const upload = job.steps.at(-1)!;
    expect(upload.if).toBe(
      "success() && steps.research_packet.outcome == 'success'",
    );
    expect(upload.with).toMatchObject({
      "retention-days": 7,
      "if-no-files-found": "error",
      path: "artifacts/integration/mockserver-research/inventory.json\nartifacts/integration/mockserver-research/receipt.json\n",
    });
    expect(job.steps.map(({ run }) => run ?? "").join("\n")).not.toMatch(
      /verify-substrate-certification|run-scenarios|maintain-artifacts/u,
    );
  });
});

const revision = "a".repeat(40);
describe("actual research shell diagnostics with synthetic commands", () => {
  it.each([
    [0, 0],
    [1, 0],
    [7, 0],
    [137, 0],
    [143, 0],
    [3, 1],
    [3, 0],
  ])(
    "preserves command status %s and verifier outcome %s without admission changes",
    (status, verifier) => {
      const workflow = parseYaml(
        readFileSync(
          resolve(
            import.meta.dirname,
            "../../../.github/workflows/integration.yml",
          ),
          "utf8",
        ),
      ) as { jobs: Record<string, WorkflowJob> };
      const script = workflow.jobs["mockserver-supplier-research"]!.steps.find(
        ({ name }) =>
          name ===
          "Require settled research stop and independently verified packet",
      )!.run!;
      const result = spawnSync(
        "/bin/bash",
        [
          "-e",
          "-c",
          `pnpm() { return ${status}; }\nnode() { return ${verifier}; }\n${script}`,
        ],
        { env: {}, encoding: "utf8", timeout: 5_000, maxBuffer: 4096 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(status === 3 && verifier === 0 ? 0 : 1);
      expect(result.stdout).toBe(
        `integration.mockserver-research.command-status=${status}\n` +
          (status === 3
            ? "integration.mockserver-research.verifier-enter\n"
            : "") +
          (status === 3 && verifier === 0
            ? "integration.mockserver-research.verifier-complete\n"
            : ""),
      );
    },
  );
});
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

describe("research request inherited configuration", () => {
  it("rejects inherited conflicting data or accessor fields without evaluation", () => {
    let reads = 0;
    const prototypes = [
      { AGENTSCOPE_INTEGRATION_SCENARIO: "codex" },
      Object.defineProperty({}, "AGENTSCOPE_INTEGRATION_SCENARIO", {
        get: () => {
          reads += 1;
          return "codex";
        },
      }),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            reads += 1;
            throw Error("synthetic");
          },
          getPrototypeOf: () => {
            reads += 1;
            throw Error("synthetic");
          },
        },
      ),
    ];
    for (const prototype of prototypes) {
      const input = environment();
      Object.setPrototypeOf(input, prototype);
      expect(() => parse(input)).toThrow("research-request");
    }
    expect(reads).toBe(0);
  });
  it("does not reinterpret an inherited request or provenance as absence", () => {
    for (const name of ["AGENTSCOPE_MOCKSERVER_RESEARCH", "GITHUB_SHA"]) {
      const input = environment();
      const value = input[name];
      Reflect.deleteProperty(input, name);
      Object.setPrototypeOf(input, { [name]: value });
      expect(() => parse(input)).toThrow("research-request");
    }
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
