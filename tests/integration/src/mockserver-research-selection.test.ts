import { spawnSync } from "node:child_process";
import type * as FileSystem from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileLocalSelection } from "./operations.js";
import { runIntegrationStages } from "./controller-stages.js";

const boundary = vi.hoisted(() => ({
  capability: vi.fn(),
  research: vi.fn(),
  compile: vi.fn(),
  verify: vi.fn(),
  select: vi.fn(),
  register: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  rename: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FileSystem>()),
  readFileSync: () => "{}",
  mkdirSync: boundary.mkdir,
  writeFileSync: boundary.write,
  renameSync: boundary.rename,
}));
vi.mock("../dist/manifest.js", () => ({
  compileCapabilityManifest: boundary.compile,
  verifyManifestEvidence: boundary.verify,
  selectCapabilityScenarios: boundary.select,
}));
vi.mock("../dist/operations.js", () => ({ compileLocalSelection }));
vi.mock("../dist/controller.js", () => ({
  requireDisposableOuterHostCapability: boundary.capability,
  requireMockServerResearchRequest: boundary.research,
  registerIntegrationArtifactFile: boundary.register,
}));

const selectorNames = [
  "AGENTSCOPE_INTEGRATION_SCENARIO",
  "AGENTSCOPE_INTEGRATION_SHARD",
  "AGENTSCOPE_INTEGRATION_FULL",
  "AGENTSCOPE_INTEGRATION_HARNESS",
  "AGENTSCOPE_INTEGRATION_TAG",
] as const;
const runSelection = async () => {
  // @ts-expect-error The private executable stage has no public type API.
  await import("../select.mjs");
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  for (const name of selectorNames) vi.stubEnv(name, undefined);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  boundary.compile.mockReturnValue({ manifestIdentity: "sha256-exact" });
  boundary.select.mockReturnValue([{ scenarioId: "exact-input" }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("actual selection stage with synthetic controller boundaries", () => {
  it("uses only the internal full preparation selector for research", async () => {
    boundary.research.mockReturnValue({ request: { kind: "supplier" } });
    const before = { ...process.env };
    await runSelection();
    expect(process.env).toEqual(before);
    expect(boundary.capability).toHaveBeenCalledOnce();
    expect(boundary.research).toHaveBeenCalledOnce();
    expect(boundary.verify).toHaveBeenCalledOnce();
    expect(boundary.select).toHaveBeenCalledWith(
      { manifestIdentity: "sha256-exact" },
      {},
    );
    expect(boundary.register).toHaveBeenCalledWith("current-selection.json");
    const serialized = boundary.write.mock.calls[0]![1] as string;
    expect(JSON.parse(serialized)).toEqual({
      selectionVersion: 2,
      manifestIdentity: "sha256-exact",
      selectionMode: "full",
      selector: {},
      scenarioIds: ["exact-input"],
    });
    expect(boundary.rename).toHaveBeenCalledOnce();
  });

  it("still rejects ordinary missing selectors before publication", async () => {
    await expect(runSelection()).rejects.toThrow(
      "integration.manifest.selector",
    );
    expect(boundary.select).not.toHaveBeenCalled();
    expect(boundary.write).not.toHaveBeenCalled();
  });

  it("preserves ordinary explicit scenario selection", async () => {
    vi.stubEnv("AGENTSCOPE_INTEGRATION_SCENARIO", "ordinary-exact");
    await runSelection();
    expect(boundary.select).toHaveBeenCalledWith(
      { manifestIdentity: "sha256-exact" },
      { scenarioId: "ordinary-exact" },
    );
    expect(
      JSON.parse(boundary.write.mock.calls[0]![1] as string),
    ).toMatchObject({
      selectionMode: "scenario",
      selector: { scenarioId: "ordinary-exact" },
    });
  });

  it.each(["missing-capability", "wrong-stage", "stale-capability"])(
    "preserves controller refusal %s before publication",
    async (failure) => {
      (failure === "missing-capability"
        ? boundary.capability
        : boundary.research
      ).mockImplementation(() => {
        throw new Error(failure);
      });
      await expect(runSelection()).rejects.toThrow(failure);
      expect(boundary.select).not.toHaveBeenCalled();
      expect(boundary.write).not.toHaveBeenCalled();
    },
  );

  it("never selects or publishes after manifest verification fails", async () => {
    boundary.verify.mockImplementation(() => {
      throw new Error("manifest-failed");
    });
    await expect(runSelection()).rejects.toThrow("manifest-failed");
    expect(boundary.research).not.toHaveBeenCalled();
    expect(boundary.select).not.toHaveBeenCalled();
    expect(boundary.write).not.toHaveBeenCalled();
  });
});

describe("research selection preserves controller execution fences", () => {
  it("rejects a caller of the real getter without a live capability", () => {
    const modulePath = resolve(import.meta.dirname, "../dist/controller.js");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const { requireMockServerResearchRequest } = await import(${JSON.stringify(modulePath)});
      try { requireMockServerResearchRequest(); process.exit(2); }
      catch (error) { console.log(error.message); }
    `,
      ],
      { env: {}, encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "integration.outer-host.capability-required",
    );
  });

  it("causally stops before preparation and supplier work on selection failure", async () => {
    const events: string[] = [];
    const child = (name: string) => () => {
      events.push(name);
      return Promise.resolve();
    };
    const dependencies = {
      clean: child("clean"),
      maintainArtifacts: child("maintainArtifacts"),
      prepareCandidate: child("prepareCandidate"),
      prepareImages: child("prepareImages"),
      prepareModelRoutes: child("supplier"),
      runScenarios: child("runScenarios"),
      select: () => {
        events.push("select");
        compileLocalSelection({});
        return Promise.resolve();
      },
    };
    await expect(
      runIntegrationStages("lifecycle", dependencies, "mockserver-supplier"),
    ).rejects.toMatchObject({
      primaryCause: new Error("integration.manifest.selector"),
    });
    expect(events).toEqual(["select", "clean"]);
  });

  it("full preparation selection never grants scenario execution", async () => {
    const events: string[] = [];
    const child = (name: string) => () => {
      events.push(name);
      return Promise.resolve();
    };
    await expect(
      runIntegrationStages(
        "lifecycle",
        {
          clean: child("clean"),
          maintainArtifacts: child("maintainArtifacts"),
          prepareCandidate: child("prepareCandidate"),
          prepareImages: child("prepareImages"),
          prepareModelRoutes: child("supplier"),
          runScenarios: child("runScenarios"),
          select: child("select"),
        },
        "mockserver-supplier",
      ),
    ).resolves.toBe("mockserver-research-cleaned");
    expect(events).toEqual(["select", "prepareImages", "supplier", "clean"]);
  });
});
