import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Slot =
  | "scenario-missing"
  | "evidence-missing"
  | "material-association"
  | "source-not-regular"
  | "source-identity"
  | "source-digest"
  | "package-association";
type Plan = { runId: string; scenarioId: string };
type Functions = {
  stageBuildContext: (plan: Plan) => unknown;
  publishScenarioContextRefusals: () => void;
};
const source = readFileSync(
  new URL("../run-scenarios.mjs", import.meta.url),
  "utf8",
);
const fixture = (slot: Slot) => {
  const start = source.indexOf("const scenarioContextRefusals =");
  const end = source.indexOf("const prepareMockServerControl =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const predicateStart = source.indexOf("const isGateCapableMockServer =");
  const predicateEnd = source.indexOf("const confinementArguments =");
  expect(predicateStart).toBeGreaterThan(0);
  expect(predicateEnd).toBeGreaterThan(predicateStart);
  const bytes = Buffer.from("PRIVATE_CANARY source bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const plan = { runId: "0123456789abcdef", scenarioId: "fixed-scenario" };
  const scenario = {
    ...plan,
    harnessEvidenceId: "fixed-evidence",
    modelRoutes: [],
    runtimeArtifacts: [],
    scenarioProcess: {
      path: "PRIVATE_CANARY-process.mjs",
      sha256: slot === "source-digest" ? "0".repeat(64) : hash,
    },
    scenarioOracle: { path: "PRIVATE_CANARY-oracle.mjs", sha256: hash },
    fixtureAdapter: { path: "PRIVATE_CANARY-adapter.mjs", sha256: hash },
  };
  const state = { slot, sinkFails: false, stats: 0, closed: 0, opened: 0 };
  const output: string[] = [];
  const status = {
    isFile: () => true,
    isSymbolicLink: () => false,
    dev: 1,
    ino: 1,
    size: bytes.length,
    mode: 0o644,
  };
  const scenarios = slot === "scenario-missing" ? [] : [scenario];
  const evidence = {
    material: { kind: "certification-fixture", packages: [] as unknown[] },
  };
  const materials = new Map();
  if (slot === "material-association") materials.set("fixed-evidence", {});
  if (slot === "package-association") {
    evidence.material.kind = "npm";
    evidence.material.packages = [
      { installName: "vendor", packageName: "vendor", version: "1.0.0" },
    ];
    materials.set("fixed-evidence", {});
  }
  const functions = runInNewContext(
    `${source.slice(predicateStart, predicateEnd)}\n${source.slice(start, end)}; ({ stageBuildContext, publishScenarioContextRefusals })`,
    {
      Buffer,
      createHash,
      dirname,
      resolve,
      artifactsRoot: "/PRIVATE_CANARY-artifacts",
      integrationRoot: "/PRIVATE_CANARY-integration",
      workspaceRoot: "/PRIVATE_CANARY-workspace",
      candidateDirectory: "/PRIVATE_CANARY-candidate",
      candidate: { bundleIdentity: "fixed-bundle" },
      cliArtifact: { fileName: "cli.tgz" },
      selectedRuntimeFiles: [],
      manifest: { scenarios },
      preparedHarnessMaterials: materials,
      evidenceById: new Map(
        slot === "evidence-missing" ? [] : [["fixed-evidence", evidence]],
      ),
      constants: { O_RDONLY: 1, O_NOFOLLOW: 2 },
      rmSync: () => {},
      mkdirSync: () => {},
      cpSync: () => {},
      stageEsmPackageBoundary: () => {},
      stagePreparedHarnessMaterial: () => {},
      inspectPreparedHarnessMaterial: () => ({ kind: "npm", packages: [] }),
      writeExactRegularFile: () => {},
      writeFileSync: () => {},
      lstatSync: () => ({
        ...status,
        isFile: () => state.slot !== "source-not-regular",
      }),
      openSync: (_path: string, flags: number) => {
        expect(flags).toBe(3);
        state.opened++;
        return 7;
      },
      closeSync: (fd: number) => {
        expect(fd).toBe(7);
        state.closed++;
      },
      fstatSync: () => ({
        ...status,
        ino:
          state.slot === "source-identity" && ++state.stats % 2 === 0 ? 2 : 1,
      }),
      readFileSync: () => bytes,
      process: {
        stderr: {
          write: (text: string) => {
            if (state.sinkFails) throw new Error("PRIVATE_CANARY sink");
            output.push(text);
          },
        },
      },
    },
  ) as Functions;
  return { functions, state, plan, output };
};
const records = (output: string[]) =>
  output.map((text) => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
    expect(text.startsWith("integration.isolation.context-diagnostic:")).toBe(
      true,
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("PRIVATE_CANARY");
    return JSON.parse(text.slice(text.indexOf(":") + 1)) as unknown;
  });
describe("actual-source first per-run context refusal diagnostics", () => {
  it("keeps a valid context construction silent and closes every held source", () => {
    const f = fixture("source-not-regular");
    f.state.slot = "scenario-missing";
    expect(f.functions.stageBuildContext(f.plan)).toMatchObject({
      context: "/PRIVATE_CANARY-artifacts/contexts/0123456789abcdef/scenario",
      requiresHarnessBuildContextBound: false,
    });
    f.functions.publishScenarioContextRefusals();
    expect(f.output).toEqual([]);
    expect(f.state.opened).toBeGreaterThan(0);
    expect(f.state.closed).toBe(f.state.opened);
  });
  it.each<Slot>([
    "scenario-missing",
    "evidence-missing",
    "material-association",
    "source-not-regular",
    "source-identity",
    "source-digest",
    "package-association",
  ])("keeps the stable rejection and reports only closed slot %s", (slot) => {
    const f = fixture(slot);
    expect(() => f.functions.stageBuildContext(f.plan)).toThrow(
      "integration.isolation.context",
    );
    expect(f.output).toEqual([]);
    f.functions.publishScenarioContextRefusals();
    expect(records(f.output)).toEqual([{ ...f.plan, slot }]);
    expect(f.state.closed).toBe(f.state.opened);
    if (slot === "source-identity" || slot === "source-digest")
      expect(f.state.closed).toBeGreaterThan(0);
  });
  it("retains the first refusal per actual run, not a later sibling or second failure", () => {
    const f = fixture("source-digest");
    expect(() => f.functions.stageBuildContext(f.plan)).toThrow(
      "integration.isolation.context",
    );
    f.state.slot = "source-not-regular";
    expect(() => f.functions.stageBuildContext(f.plan)).toThrow(
      "integration.isolation.context",
    );
    const sibling = { runId: "fedcba9876543210", scenarioId: "fixed-scenario" };
    expect(() => f.functions.stageBuildContext(sibling)).toThrow(
      "integration.isolation.context",
    );
    f.functions.publishScenarioContextRefusals();
    expect(records(f.output)).toEqual([
      { ...f.plan, slot: "source-digest" },
      { ...sibling, slot: "source-not-regular" },
    ]);
    expect(f.state.closed).toBe(f.state.opened);
  });
  it("optional sink failure cannot throw or change the original rejection", () => {
    const f = fixture("source-identity");
    expect(() => f.functions.stageBuildContext(f.plan)).toThrow(
      "integration.isolation.context",
    );
    f.state.sinkFails = true;
    expect(() => {
      f.functions.publishScenarioContextRefusals();
    }).not.toThrow();
    expect(f.output).toEqual([]);
    f.state.sinkFails = false;
    f.functions.publishScenarioContextRefusals();
    expect(records(f.output)).toEqual([{ ...f.plan, slot: "source-identity" }]);
    expect(f.state.closed).toBe(f.state.opened);
  });
  it("does not export malformed or private plan identifiers", () => {
    const f = fixture("scenario-missing");
    for (const plan of [
      { ...f.plan, runId: "PRIVATE_CANARY" },
      { ...f.plan, scenarioId: "PRIVATE_CANARY" },
      { ...f.plan, scenarioId: "a".repeat(129) },
    ])
      expect(() => f.functions.stageBuildContext(plan)).toThrow(
        "integration.isolation.context",
      );
    f.functions.publishScenarioContextRefusals();
    expect(f.output).toEqual([]);
  });
  it("publishes only from the existing outer catch, not privileged or admission paths", () => {
    expect(source).toContain(
      '} catch (error) {\n  publishOperationFailureDiagnostic("runtime-original", error);\n  publishScenarioContextRefusals();\n  if (',
    );
    expect(source.match(/publishScenarioContextRefusals\(\);/gu)).toHaveLength(
      1,
    );
  });
});
