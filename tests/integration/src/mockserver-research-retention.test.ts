import { performance } from "node:perf_hooks";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { runSupervisedProcess } from "../supervisor.mjs";
import {
  retainMockServerResearch,
  verifyMockServerResearch,
  type MockServerResearchProvenance,
} from "../mockserver-material/research-retention.mjs";
import { mockServerResearchStopFitsTerminalObservation } from "./mockserver-research-request.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const child = () =>
  runSupervisedProcess({
    arguments_: ["-e", "process.exit(3)"],
    environment: {},
    executable: process.execPath,
    maximumMilliseconds: 2_000,
    stdio: "ignore",
  });

describe("existing supervisor research terminal observations", () => {
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
  it("observes a normally joined synthetic exit3 without an intervention", async () => {
    const result = await child();
    expect(result).toMatchObject({
      code: 3,
      signal: null,
      contained: true,
      residualWorkObserved: false,
      terminationInitiated: false,
      completedWithinDeadline: true,
    });
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(true);
  });

  it("rejects a late terminal observation even before the timer callback runs", async () => {
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      calls += 1;
      return calls < 5 ? 10 : 2_011;
    });
    const result = await child();
    expect(result.code).toBe(3);
    expect(result.terminationInitiated).toBe(false);
    expect(result.completedWithinDeadline).toBe(false);
    expect(mockServerResearchStopFitsTerminalObservation(result)).toBe(false);
  });
});

const hash = "a".repeat(64);
const inventory = () =>
  Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceScope: "untrusted-cache-and-jar-research-only",
      consumedDependencyClosure: "not-proved",
      caches: [
        { path: "maven-repository", type: "directory", mode: 0o700 },
        { path: "npm-cache", type: "directory", mode: 0o700 },
      ],
      artifact: {
        path: "source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar",
        type: "file",
        bytes: 1,
        mode: 0o644,
        sha256: hash,
      },
    })}\n`,
  );
const binding = (): MockServerResearchProvenance => ({
  request: {
    kind: "supplier",
    repository: "owner/repo",
    revision: "a".repeat(40),
    runId: "1234",
    attempt: "1",
    workflowRef:
      "owner/repo/.github/workflows/integration.yml@refs/heads/research",
    workflowRevision: "a".repeat(40),
  },
  sourceTree: "b".repeat(40),
  controllerAuthority: `sha256:${hash}`,
  runToken: "a".repeat(16),
  manifestIdentity: `sha256-${hash}`,
  preparedEvidenceSha256: hash,
  bootstrapVerificationSha256: hash,
  recipeSourcesSha256: hash,
});
const fixture = () => {
  const parent = realpathSync(
    mkdtempSync(resolve(tmpdir(), "agentscope-research-retention-")),
  );
  roots.push(parent);
  const started = performance.now();
  const deadline = started + 10_000;
  const provenance = binding();
  const signal = new AbortController().signal;
  return {
    parent,
    deadline,
    provenance,
    signal,
    inventory: inventory(),
    stage: {
      started,
      finished: started,
      deadline: started + 5_000,
      clientSettlement: "closed-and-registered-for-outer-retirement" as const,
    },
    verification: { parent, deadline, expectedProvenance: provenance, signal },
    path: resolve(parent, "mockserver-research"),
  };
};

describe("dedicated noncertifying research packet", () => {
  it("retains inventory first and a separately verified receipt last", () => {
    const input = fixture();
    const retained = retainMockServerResearch(input);
    expect(verifyMockServerResearch(input.verification)).toEqual(retained);
    const receipt = JSON.parse(
      readFileSync(resolve(input.path, "receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      supportAdmission: "not-claimed",
      consumedDependencyClosure: "not-proved",
      cleanup: {
        disposition: "canonical-clean-complete",
        outerHostRetirement: "external-not-observed",
      },
      stage: { clientSettlement: "closed-and-registered-for-outer-retirement" },
      provenance: input.provenance,
    });
  });
  it("does not adopt or delete a prior complete packet", () => {
    const input = fixture();
    const first = retainMockServerResearch(input);
    expect(() => retainMockServerResearch(input)).toThrow();
    expect(verifyMockServerResearch(input.verification)).toEqual(first);
  });
  it("leaves an inventory-only prefix quarantined on deadline, never complete", () => {
    const input = fixture();
    const now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() =>
      existsSync(resolve(input.path, "inventory.json")) ? input.deadline : now,
    );
    expect(() => retainMockServerResearch(input)).toThrow("research-retention");
    expect(existsSync(resolve(input.path, "inventory.json"))).toBe(true);
    expect(existsSync(resolve(input.path, "receipt.json"))).toBe(false);
    vi.restoreAllMocks();
    expect(() => verifyMockServerResearch(input.verification)).toThrow();
  });
  it("fails after a late receipt commit rather than returning completed output", () => {
    const input = fixture();
    const now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() =>
      existsSync(resolve(input.path, "receipt.json")) ? input.deadline : now,
    );
    expect(() => retainMockServerResearch(input)).toThrow("research-retention");
    expect(existsSync(resolve(input.path, "receipt.json"))).toBe(true);
  });
  it("admits no directory or file after cancellation or an expired entry", () => {
    for (const cancelled of [true, false]) {
      const input = fixture();
      const abort = new AbortController();
      if (cancelled) abort.abort();
      expect(() =>
        retainMockServerResearch({
          ...input,
          signal: abort.signal,
          deadline: cancelled ? input.deadline : performance.now(),
        }),
      ).toThrow("research-retention");
      expect(existsSync(input.path)).toBe(false);
    }
  });
});

describe("research packet substitution boundary", () => {
  it("checks the independent source expectation without treating runtime observations as external authority", () => {
    const input = fixture();
    const result = retainMockServerResearch(input);
    const { request, sourceTree, manifestIdentity, recipeSourcesSha256 } =
      input.provenance;
    const expectedSource = {
      request,
      sourceTree,
      manifestIdentity,
      recipeSourcesSha256,
    };
    const verification = {
      parent: input.parent,
      deadline: input.deadline,
      signal: input.signal,
      expectedSource,
    };
    expect(verifyMockServerResearch(verification)).toEqual(result);
    const extraSource = { ...expectedSource, extra: true };
    expect(() =>
      verifyMockServerResearch({
        ...verification,
        expectedSource: { ...expectedSource, sourceTree: "c".repeat(40) },
      }),
    ).toThrow("research-retention");
    expect(() =>
      verifyMockServerResearch({
        ...verification,
        expectedSource: extraSource,
      }),
    ).toThrow("research-retention");
  });
  it.each([
    "extra",
    "missing",
    "symlink",
    "hardlink",
    "mode",
    "content",
    "replaced-root",
    "oversize",
  ])("rejects %s filesystem evidence", (attack) => {
    const input = fixture();
    retainMockServerResearch(input);
    const target = resolve(input.path, "inventory.json");
    if (attack === "extra") writeFileSync(resolve(input.path, "extra"), "no");
    if (attack === "missing") rmSync(target);
    if (attack === "symlink") {
      renameSync(target, resolve(input.parent, "saved"));
      symlinkSync(resolve(input.parent, "saved"), target);
    }
    if (attack === "hardlink") linkSync(target, resolve(input.parent, "alias"));
    if (attack === "mode") chmodSync(target, 0o644);
    if (attack === "content")
      writeFileSync(
        target,
        inventory().toString().replace(hash, "b".repeat(64)),
      );
    if (attack === "replaced-root") {
      renameSync(input.path, resolve(input.parent, "original"));
      symlinkSync(resolve(input.parent, "original"), input.path);
    }
    if (attack === "oversize")
      writeFileSync(target, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => verifyMockServerResearch(input.verification)).toThrow();
  });
  it.each(["runId", "attempt", "revision"])(
    "rejects a mixed %s provenance",
    (field) => {
      const input = fixture();
      retainMockServerResearch(input);
      const changed = binding();
      const request = {
        ...changed.request,
        [field]: field === "revision" ? "b".repeat(40) : "2",
      };
      expect(() =>
        verifyMockServerResearch({
          ...input.verification,
          expectedProvenance: { ...changed, request },
        }),
      ).toThrow("research-retention");
    },
  );
  it("rejects source/recipe substitutions and alternative receipt encodings", () => {
    const input = fixture();
    retainMockServerResearch(input);
    expect(() =>
      verifyMockServerResearch({
        ...input.verification,
        expectedProvenance: {
          ...binding(),
          recipeSourcesSha256: "b".repeat(64),
        },
      }),
    ).toThrow("research-retention");
    const target = resolve(input.path, "receipt.json");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, ` ${original}`);
    expect(() => verifyMockServerResearch(input.verification)).toThrow(
      "research-retention",
    );
  });
});

describe("hostile research provenance", () => {
  it("rejects hostile provenance accessors and proxies without invoking hooks", () => {
    const input = fixture();
    const trap = vi.fn(() => {
      throw new Error("untrusted hook");
    });
    const getter = binding();
    Object.defineProperty(getter, "sourceTree", {
      get: trap,
      enumerable: true,
    });
    const proxy = new Proxy(binding(), { ownKeys: trap });
    for (const provenance of [getter, proxy])
      expect(() => retainMockServerResearch({ ...input, provenance })).toThrow(
        "research-retention",
      );
    expect(trap).not.toHaveBeenCalled();
    expect(existsSync(input.path)).toBe(false);
  });
});

type WorkflowStep = {
  name?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = { if?: string; steps: WorkflowStep[]; needs?: string };
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
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.mockserver_research",
    );
    expect(job.needs).toBe("prepare-candidate");
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
    expect(execution.run).toBe(
      'set +e\npnpm test:integration\nstatus=$?\nset -e\ntest "$status" -eq 3\nnode tests/integration/verify-mockserver-research.mjs\n',
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
