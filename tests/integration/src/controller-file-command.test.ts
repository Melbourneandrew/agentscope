import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Private executable diagnostics have no public type API.
import * as fileCommands from "../controller-file-command.mjs";
const {
  publishControllerFailureObservation,
  publishSupervisorObservation,
  publishMaterialResearchPhase,
  publishBootstrapGpgObservation,
} = fileCommands as unknown as Record<
  | "publishControllerFailureObservation"
  | "publishSupervisorObservation"
  | "publishBootstrapGpgObservation"
  | "publishMaterialResearchPhase",
  (value: unknown, environment: NodeJS.ProcessEnv) => void
>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function sink() {
  const root = mkdtempSync(
    resolve(tmpdir(), "agentscope-controller-diagnostic-"),
  );
  roots.push(root);
  const output = resolve(root, "output");
  writeFileSync(output, "", { mode: 0o600 });
  return {
    root,
    output,
    env: { AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier", GITHUB_OUTPUT: output },
  };
}
const terminal = Object.freeze({
  code: 3,
  signal: null,
  contained: true,
  residualWorkObserved: false,
  terminationInitiated: false,
  completedWithinDeadline: true,
});
const failure = Object.freeze({
  failure: "integration.controller.retire-outer-host",
  stage: "prepareImages",
  kind: "pull-outcome-unknown",
  cleanup: "not-attempted",
  imagePreparation: { trigger: "timeout", reconciliation: "failed" },
});

describe("optional closed controller file commands", () => {
  it("projects only a fixed material step without a success or cleanup claim", () => {
    const value = sink();
    publishMaterialResearchPhase("download-source", value.env);
    publishMaterialResearchPhase("verify-maven", value.env);
    for (const phase of ["download-source\nCANARY=true", {}, null, "success"])
      publishMaterialResearchPhase(phase, value.env);
    expect(readFileSync(value.output, "utf8")).toBe(
      "material_phase=download-source\nmaterial_phase=verify-maven\n" +
        "material_phase=unknown\n".repeat(4),
    );
    publishMaterialResearchPhase("supplier-build", {
      ...value.env,
      GITHUB_OUTPUT: value.root,
    });
    publishMaterialResearchPhase("supplier-build", {
      ...value.env,
      AGENTSCOPE_MOCKSERVER_RESEARCH: "other",
    });
    expect(readFileSync(value.output, "utf8")).not.toContain("supplier-build");
  });
  it("retains only fixed terminal and failure projections", () => {
    const value = sink();
    publishSupervisorObservation(terminal, value.env);
    publishControllerFailureObservation(failure, value.env);
    const text = readFileSync(value.output, "utf8");
    expect(text).toContain(
      "supervisor_observation=terminal\nsupervisor_code=3\n",
    );
    expect(text).toContain("controller_stage=prepareImages\n");
    expect(text).toContain(
      "controller_pull_trigger=timeout\ncontroller_reconciliation=failed\n",
    );
    expect(text.length).toBeLessThan(1024);
  });
  it("records rejection without reading or printing an exception", () => {
    const value = sink();
    publishSupervisorObservation(undefined, value.env);
    expect(readFileSync(value.output, "utf8")).toContain(
      "supervisor_observation=rejected\nsupervisor_code=unknown\n",
    );
  });
  it("ignores unavailable sinks and refuses nonresearch mode", () => {
    const value = sink();
    for (const output of [
      value.root,
      `${value.root}/missing`,
      "relative",
      "\0CANARY",
    ])
      expect(() => {
        publishSupervisorObservation(terminal, {
          ...value.env,
          GITHUB_OUTPUT: output,
        });
      }).not.toThrow();
    publishSupervisorObservation(terminal, {
      ...value.env,
      AGENTSCOPE_MOCKSERVER_RESEARCH: "other",
    });
    expect(readFileSync(value.output, "utf8")).toBe("");
  });
  it("never executes hostile getters or emits injected file commands", () => {
    const value = sink();
    let accesses = 0;
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          accesses += 1;
          throw new Error("CANARY");
        },
      },
    );
    publishSupervisorObservation(hostile, value.env);
    publishControllerFailureObservation(
      { ...failure, stage: "select\nCANARY=true", imagePreparation: hostile },
      value.env,
    );
    publishSupervisorObservation(
      Object.defineProperty({}, "code", {
        get() {
          accesses += 1;
          return 0;
        },
      }),
      value.env,
    );
    expect(accesses).toBe(0);
    expect(readFileSync(value.output, "utf8")).not.toContain("CANARY");
  });
});

describe("signature-policy substage projection", () => {
  it.each([
    "recordset",
    "recordset-information",
    "recordset-rejection",
    "recordset-unknown",
    "count",
    "compliance",
    "signer",
    "algorithm",
    "hash",
    "class",
    "time",
    "key-time",
  ])("projects only the fixed signature-%s substage", (substage) => {
    const workflow = parseYaml(
      readFileSync(
        new URL("../../../.github/workflows/integration.yml", import.meta.url),
        "utf8",
      ),
    ) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
    const projection = workflow.jobs[
      "mockserver-supplier-research"
    ]!.steps.find(
      ({ name }) => name === "Project closed research shell observations",
    )!;
    const projected = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-e", "-c", projection.run!],
      {
        env: {
          OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE: `signature-${substage}`,
          OBSERVED_UNTRUSTED_BOOTSTRAP_FAILURE_FAMILY: "signature-policy",
        },
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
      },
    );
    expect(projected.error).toBeUndefined();
    expect(projected.status).toBe(0);
    expect(projected.stdout).toContain(
      `untrusted_bootstrap_stage=signature-${substage} untrusted_bootstrap_failure_family=signature-policy`,
    );
    const value = sink();
    publishBootstrapGpgObservation(
      {
        process: {
          untrustedBootstrapStage: `signature-${substage}`,
          untrustedBootstrapFailureFamily: "signature-policy",
        },
      },
      value.env,
    );
    expect(readFileSync(value.output, "utf8")).toContain(
      `untrusted_bootstrap_stage=signature-${substage}\nuntrusted_bootstrap_failure_family=signature-policy\n`,
    );
    writeFileSync(value.output, "");
    publishBootstrapGpgObservation(
      {
        process: {
          untrustedBootstrapStage: `signature-${substage}\nCANARY`,
        },
      },
      value.env,
    );
    expect(readFileSync(value.output, "utf8")).not.toContain("CANARY");
    expect(readFileSync(value.output, "utf8")).toContain(
      "untrusted_bootstrap_stage=unknown\n",
    );
  });
});

describe("fixed supplier phase projection", () => {
  it.each([
    "supplier-connected-entry",
    "supplier-connected-extract",
    "supplier-connected-package",
    "supplier-connected-inventory",
    "supplier-connected-inventory-read",
    "supplier-connected-inventory-guard",
    "supplier-connected-output-create",
    "supplier-connected-output-write",
    "supplier-entry",
    "supplier-extract",
    "supplier-package",
    "supplier-inventory",
    "supplier-inventory-read",
    "supplier-inventory-guard",
    "supplier-output-create",
    "supplier-output-write",
  ])("projects last-entered %s only with none family", (stage) => {
    for (const family of [
      "none",
      "input",
      "filesystem",
      "gpg-execution",
      "listing-policy",
      "signature-policy",
      "checksum-policy",
      "CANARY",
    ]) {
      const value = sink();
      publishBootstrapGpgObservation(
        {
          process: {
            untrustedBootstrapStage: stage,
            untrustedBootstrapFailureFamily: family,
          },
        },
        value.env,
      );
      const text = readFileSync(value.output, "utf8");
      expect(text).toContain(
        `untrusted_bootstrap_stage=${family === "none" ? stage : "unknown"}\n`,
      );
      expect(text).toContain(
        `untrusted_bootstrap_failure_family=${family === "none" ? "none" : "unknown"}\n`,
      );
      expect(text).not.toContain("CANARY");
    }
  });
});

describe("existing builder diagnostic projection", () => {
  it("distinguishes a recorded markerless failure from absent diagnostics", () => {
    const value = sink();
    publishBootstrapGpgObservation(
      {
        operationKind: "image-build",
        outcome: "failed-settled",
        process: {
          observed: true,
          exited: true,
          signaled: false,
          timedOut: false,
          joined: true,
          stderrClass: "build-failed",
        },
      },
      value.env,
    );
    const text = readFileSync(value.output, "utf8");
    expect(text).toBe(
      "untrusted_builder_operation=image-build\nuntrusted_builder_outcome=failed-settled\n" +
        "untrusted_builder_observed=true\nuntrusted_builder_exited=true\nuntrusted_builder_signaled=false\n" +
        "untrusted_builder_timed_out=false\nuntrusted_builder_joined=true\nuntrusted_builder_stderr_class=build-failed\n" +
        "untrusted_bootstrap_stage=unknown\nuntrusted_bootstrap_failure_family=unknown\n",
    );
    writeFileSync(value.output, "");
    publishBootstrapGpgObservation(undefined, value.env);
    expect(
      readFileSync(value.output, "utf8").split("\n").filter(Boolean),
    ).toHaveLength(10);
    expect(readFileSync(value.output, "utf8")).not.toMatch(/=(?!unknown\n)/u);
  });
  it.each(["preflight", "builder-create", "builder-bootstrap", "image-build"])(
    "projects closed operation %s without changing authority",
    (operationKind) => {
      const value = sink();
      publishBootstrapGpgObservation(
        {
          operationKind,
          outcome: "retired-failure",
          process: {
            observed: false,
            exited: false,
            signaled: true,
            timedOut: true,
            joined: false,
            stderrClass: "permission-denied",
            untrustedBootstrapStage: "import-key",
            untrustedBootstrapFailureFamily: "gpg-execution",
          },
        },
        value.env,
      );
      expect(readFileSync(value.output, "utf8")).toContain(
        `untrusted_builder_operation=${operationKind}\n`,
      );
      expect(readFileSync(value.output, "utf8")).toContain(
        "untrusted_builder_outcome=retired-failure\n",
      );
      expect(readFileSync(value.output, "utf8")).toContain(
        "untrusted_bootstrap_stage=import-key\n",
      );
    },
  );
  it("does not read proxies/accessors or coerce malformed fields", () => {
    const value = sink();
    const getter = vi.fn(() => {
      throw new Error("CANARY");
    });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter });
    for (const diagnostic of [
      proxy,
      { process: proxy },
      Object.defineProperty({}, "process", { get: getter }),
      {
        operationKind: "image-build\nCANARY",
        outcome: {},
        process: {
          observed: "true",
          exited: 1,
          signaled: [],
          timedOut: null,
          joined: "false",
          stderrClass: "$(CANARY)",
        },
      },
    ])
      publishBootstrapGpgObservation(diagnostic, value.env);
    expect(getter).not.toHaveBeenCalled();
    expect(readFileSync(value.output, "utf8")).not.toContain("CANARY");
    expect(readFileSync(value.output, "utf8")).not.toMatch(/=(?!unknown\n)/u);
    expect(() => {
      publishBootstrapGpgObservation(
        {},
        { ...value.env, GITHUB_OUTPUT: value.root },
      );
    }).not.toThrow();
  });
});

const executableBody = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gmu, "")
    .replaceAll("import.meta.dirname", '"/synthetic"');

describe("actual entrypoint disposition despite lost diagnostic sinks", () => {
  it.each(["terminal", "rejected"])(
    "preserves supervisor %s with unavailable stdout/stderr",
    async (kind) => {
      const value = sink();
      const processStub = {
        env: value.env,
        execPath: "/synthetic/node",
        exitCode: 0,
        stdout: {
          once() {},
          write() {
            throw new Error("CANARY");
          },
        },
        stderr: {
          once() {},
          write() {
            throw new Error("CANARY");
          },
        },
      };
      await runInNewContext(
        `(async () => {${executableBody("controller.mjs")}})()`,
        {
          process: processStub,
          resolve: () => "synthetic-entry",
          runSupervisedProcess: () =>
            kind === "terminal"
              ? Promise.resolve({ ...terminal, code: 1 })
              : Promise.reject(new Error("CANARY")),
          mockServerResearchStopFitsTerminalObservation: () => false,
          publishSupervisorObservation: (result: unknown) => {
            publishSupervisorObservation(result, value.env);
          },
        },
        { timeout: 100 },
      );
      expect(processStub.exitCode).toBe(1);
      expect(readFileSync(value.output, "utf8")).toContain(
        `supervisor_observation=${kind}\n`,
      );
    },
  );
  it("preserves research stop 3 when file commands and stdout both fail", async () => {
    const value = sink();
    const processStub = {
      env: value.env,
      execPath: "/synthetic/node",
      exitCode: 0,
      stdout: {
        once() {},
        write() {
          throw new Error("CANARY");
        },
      },
    };
    await runInNewContext(
      `(async () => {${executableBody("controller.mjs")}})()`,
      {
        process: processStub,
        resolve: () => "synthetic-entry",
        runSupervisedProcess: () => Promise.resolve(terminal),
        mockServerResearchStopFitsTerminalObservation: () => true,
        publishSupervisorObservation: (result: unknown) => {
          publishSupervisorObservation(result, {
            ...value.env,
            GITHUB_OUTPUT: value.root,
          });
        },
      },
      { timeout: 100 },
    );
    expect(processStub.exitCode).toBe(3);
  });
  it("mirrors controller failure before best-effort stderr and original exit 1", async () => {
    const value = sink();
    const exit = vi.fn();
    await runInNewContext(
      `(async () => {${executableBody("controller-process.mjs")}})()`,
      {
        executeIntegrationController: () => Promise.reject(new Error("CANARY")),
        readControllerFailureDiagnostic: () => failure,
        formatControllerFailureDiagnostic: () => "fixed diagnostic\n",
        publishControllerFailureObservation: (result: unknown) => {
          publishControllerFailureObservation(result, value.env);
        },
        process: {
          exit,
          stderr: {
            once() {},
            write() {
              throw new Error("CANARY");
            },
          },
        },
      },
      { timeout: 100 },
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(readFileSync(value.output, "utf8")).toContain(
      "controller_failure=integration.controller.retire-outer-host\n",
    );
    expect(readFileSync(value.output, "utf8")).not.toContain("CANARY");
  });
});
