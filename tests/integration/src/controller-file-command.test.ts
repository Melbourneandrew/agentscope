import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Private executable diagnostics have no public type API.
import * as fileCommands from "../controller-file-command.mjs";
const { publishControllerFailureObservation, publishSupervisorObservation } =
  fileCommands as unknown as Record<
    "publishControllerFailureObservation" | "publishSupervisorObservation",
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
