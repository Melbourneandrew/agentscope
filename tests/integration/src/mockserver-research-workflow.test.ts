import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
const workflow = parseYaml(
  readFileSync(
    resolve(import.meta.dirname, "../../../.github/workflows/integration.yml"),
    "utf8",
  ),
) as { jobs: Record<string, { steps: Step[] }> };
const steps = workflow.jobs["mockserver-supplier-research"]!.steps;
const execution = steps.find(({ id }) => id === "research_packet")!;
const projection = steps.find(
  ({ name }) => name === "Project closed research shell observations",
)!;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(resolve(tmpdir(), "agentscope-research-shell-"));
  roots.push(value);
  return value;
}
function shell(script: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-e", "-c", script],
    {
      env,
      encoding: "utf8",
      timeout: 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}
function run(
  status: number,
  verifier: number,
  prefix = "",
  outputFailure = false,
) {
  const directory = root();
  const output = outputFailure ? directory : resolve(directory, "output");
  const result = shell(
    `pnpm() { return ${status}; }\nnode() { return ${verifier}; }\n${prefix}\n${execution.run!}`,
    { GITHUB_OUTPUT: output },
  );
  return {
    result,
    output: outputFailure ? null : readFileSync(output, "utf8"),
  };
}

async function closedReader(script: string, env: NodeJS.ProcessEnv) {
  const child = spawn(
    "/bin/bash",
    ["--noprofile", "--norc", "-e", "-c", `IFS= read -r ready\n${script}`],
    { env, stdio: ["pipe", "pipe", "ignore"] },
  );
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 2_000);
  try {
    const terminal = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolveTerminal, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolveTerminal({ code, signal });
      });
    });
    // Close the real child stdout reader before releasing its first write.
    await new Promise<void>((resolveClosed) => {
      child.stdout.once("close", resolveClosed);
      child.stdout.destroy();
    });
    child.stdin.end("ready\n");
    const result = await terminal;
    expect(expired).toBe(false);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

describe("actual research workflow shell file commands", () => {
  it("keeps diagnostics separate from the unchanged verifier and upload predicate", () => {
    const script = execution.run!;
    expect(script.indexOf("diagnostic_output shell_entered true")).toBeLessThan(
      script.indexOf("pnpm test:integration"),
    );
    expect(script.indexOf("status=$?")).toBeLessThan(
      script.indexOf("diagnostic_output command_status"),
    );
    expect(script.indexOf('test "$status" -eq 3')).toBeLessThan(
      script.indexOf("node tests/integration/verify-mockserver-research.mjs"),
    );
    expect(script).not.toContain("eval");
    expect(projection.if).toBe("always()");
    expect(projection.env).toEqual({
      OBSERVED_OUTCOME: "${{ steps.research_packet.outcome }}",
      OBSERVED_ENTERED: "${{ steps.research_packet.outputs.shell_entered }}",
      OBSERVED_COMMAND_STATUS:
        "${{ steps.research_packet.outputs.command_status }}",
      OBSERVED_SHELL_STATUS:
        "${{ steps.research_packet.outputs.shell_status }}",
      OBSERVED_SUPERVISOR:
        "${{ steps.research_packet.outputs.supervisor_observation }}",
      OBSERVED_SUPERVISOR_CODE:
        "${{ steps.research_packet.outputs.supervisor_code }}",
      OBSERVED_SUPERVISOR_SIGNAL:
        "${{ steps.research_packet.outputs.supervisor_signal }}",
      OBSERVED_CONTAINED:
        "${{ steps.research_packet.outputs.supervisor_contained }}",
      OBSERVED_RESIDUAL:
        "${{ steps.research_packet.outputs.supervisor_residual }}",
      OBSERVED_TERMINATION:
        "${{ steps.research_packet.outputs.supervisor_termination }}",
      OBSERVED_WITHIN_DEADLINE:
        "${{ steps.research_packet.outputs.supervisor_within_deadline }}",
      OBSERVED_FAILURE:
        "${{ steps.research_packet.outputs.controller_failure }}",
      OBSERVED_STAGE: "${{ steps.research_packet.outputs.controller_stage }}",
      OBSERVED_KIND: "${{ steps.research_packet.outputs.controller_kind }}",
      OBSERVED_CLEANUP:
        "${{ steps.research_packet.outputs.controller_cleanup }}",
      OBSERVED_PULL_TRIGGER:
        "${{ steps.research_packet.outputs.controller_pull_trigger }}",
      OBSERVED_RECONCILIATION:
        "${{ steps.research_packet.outputs.controller_reconciliation }}",
      OBSERVED_MATERIAL_PHASE:
        "${{ steps.research_packet.outputs.material_phase }}",
      OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE:
        "${{ steps.research_packet.outputs.untrusted_bootstrap_stage }}",
      OBSERVED_UNTRUSTED_BOOTSTRAP_FAILURE_FAMILY:
        "${{ steps.research_packet.outputs.untrusted_bootstrap_failure_family }}",
      ...Object.fromEntries(
        [
          "operation",
          "outcome",
          "observed",
          "exited",
          "signaled",
          "timed_out",
          "joined",
          "stderr_class",
        ].map((key) => [
          `OBSERVED_UNTRUSTED_BUILDER_${key.toUpperCase()}`,
          `\u0024{{ steps.research_packet.outputs.untrusted_builder_${key} }}`,
        ]),
      ),
    });
    const upload = steps.at(-1)!;
    expect(upload.if).toBe(
      "success() && steps.research_packet.outcome == 'success'",
    );
    expect(upload.with).toMatchObject({
      "retention-days": 7,
      "if-no-files-found": "error",
      path: "artifacts/integration/mockserver-research/inventory.json\nartifacts/integration/mockserver-research/receipt.json\n",
    });
  });
  it.each([0, 1, 7, 137, 143, 255])(
    "retains returned command %s but fails its predicate",
    (status) => {
      const { result, output } = run(status, 0);
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(output).toBe(
        `shell_entered=true\ncommand_status=${status}\nshell_status=1\n`,
      );
      expect(result.stdout).not.toContain("verifier-enter");
    },
  );
  it.each([0, 1, 7])(
    "retains verifier result %s after exact command 3",
    (verifier) => {
      const { result, output } = run(3, verifier);
      expect(result.status).toBe(verifier);
      expect(result.signal).toBeNull();
      expect(output).toBe(
        `shell_entered=true\ncommand_status=3\nshell_status=${verifier}\n`,
      );
      expect(result.stdout).toContain("verifier-enter");
      expect(result.stdout.includes("verifier-complete")).toBe(verifier === 0);
    },
  );
});

describe("best-effort shell diagnostic failures", () => {
  it("retains file commands when stdout is lost", () => {
    const { result, output } = run(3, 0, "exec 1>/dev/null");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(output).toBe(
      "shell_entered=true\ncommand_status=3\nshell_status=0\n",
    );
  });
  it.each([
    [3, 0],
    [3, 7],
    [1, 0],
  ])(
    "does not replace status when output/trap writes fail (%s/%s)",
    (status, verifier) => {
      const { result, output } = run(status, verifier, "", true);
      expect(result.status).toBe(status === 3 ? verifier : 1);
      expect(result.signal).toBeNull();
      expect(output).toBeNull();
    },
  );
  it("does not replace outcome when stdout printf fails", () => {
    const { result, output } = run(
      3,
      0,
      'printf() { case "$1" in \'%s=%s\'*) builtin printf "$@" ;; *) return 1 ;; esac; }',
    );
    expect(result.status).toBe(0);
    expect(output).toBe(
      "shell_entered=true\ncommand_status=3\nshell_status=0\n",
    );
  });
  it("preserves verified research result and trap outputs with a closed real stdout reader", async () => {
    const directory = root();
    const output = resolve(directory, "output");
    expect(
      await closedReader(
        `pnpm() { return 3; }\nnode() { return 0; }\n${execution.run!}`,
        { GITHUB_OUTPUT: output },
      ),
    ).toEqual({ code: 0, signal: null });
    expect(readFileSync(output, "utf8")).toBe(
      "shell_entered=true\ncommand_status=3\nshell_status=0\n",
    );
  });
  it("preserves verifier failure when only the EXIT trap destination fails", () => {
    const directory = root();
    const output = resolve(directory, "output");
    const result = shell(
      `pnpm() { return 3; }\nnode() { GITHUB_OUTPUT=${JSON.stringify(directory)}; return 7; }\n${execution.run!}`,
      { GITHUB_OUTPUT: output },
    );
    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    expect(readFileSync(output, "utf8")).toBe(
      "shell_entered=true\ncommand_status=3\n",
    );
  });
  it("does not invent terminal fields for a shell killed inside the command", () => {
    const directory = root();
    const output = resolve(directory, "output");
    const result = shell(`pnpm() { kill -KILL $$; }\n${execution.run!}`, {
      GITHUB_OUTPUT: output,
    });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(readFileSync(output, "utf8")).toBe("shell_entered=true\n");
  });
});

describe("closed-reader causal seed", () => {
  it.each(["execution", "projection"])(
    "rejects the old uncontained stdout writes in %s",
    async (kind) => {
      const script = (kind === "execution" ? execution.run! : projection.run!)
        .replaceAll("( printf ", "printf ")
        .replaceAll(" ) || :", " || :");
      const directory = root();
      const result = await closedReader(
        `pnpm() { return 3; }\nnode() { return 0; }\n${script}`,
        {
          GITHUB_OUTPUT: resolve(directory, "output"),
          GITHUB_STEP_SUMMARY: resolve(directory, "summary"),
          OBSERVED_OUTCOME: "success",
          OBSERVED_ENTERED: "true",
          OBSERVED_COMMAND_STATUS: "3",
          OBSERVED_SHELL_STATUS: "0",
        },
      );
      expect(result).toEqual({ code: null, signal: "SIGPIPE" });
    },
  );
});

describe("untrusted existing builder observations", () => {
  it("projects a markerless recorded failure without implying cleanup success", () => {
    const result = shell(projection.run!, {
      OBSERVED_UNTRUSTED_BUILDER_OPERATION: "image-build",
      OBSERVED_UNTRUSTED_BUILDER_OUTCOME: "failed-settled",
      OBSERVED_UNTRUSTED_BUILDER_OBSERVED: "true",
      OBSERVED_UNTRUSTED_BUILDER_EXITED: "true",
      OBSERVED_UNTRUSTED_BUILDER_SIGNALED: "false",
      OBSERVED_UNTRUSTED_BUILDER_TIMED_OUT: "false",
      OBSERVED_UNTRUSTED_BUILDER_JOINED: "true",
      OBSERVED_UNTRUSTED_BUILDER_STDERR_CLASS: "build-failed",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "untrusted_builder_operation=image-build untrusted_builder_outcome=failed-settled untrusted_builder_observed=true untrusted_builder_exited=true untrusted_builder_signaled=false untrusted_builder_timed_out=false untrusted_builder_joined=true untrusted_builder_stderr_class=build-failed",
    );
    expect(result.stdout).toContain("cleanup=unknown");
    expect(result.stdout).toContain("untrusted_bootstrap_stage=unknown");
  });
  it.each(["preflight", "builder-create", "builder-bootstrap", "image-build"])(
    "permits only closed operation %s",
    (operation) => {
      const result = shell(projection.run!, {
        OBSERVED_UNTRUSTED_BUILDER_OPERATION: operation,
        OBSERVED_UNTRUSTED_BUILDER_OUTCOME: "retired-failure",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `untrusted_builder_operation=${operation} untrusted_builder_outcome=retired-failure`,
      );
    },
  );
  it.each(["CANARY\nsecret", "$(exit 8)", "true ", "1"])(
    "sanitizes every builder field %s",
    (value) => {
      const environment = Object.fromEntries(
        [
          "OPERATION",
          "OUTCOME",
          "OBSERVED",
          "EXITED",
          "SIGNALED",
          "TIMED_OUT",
          "JOINED",
          "STDERR_CLASS",
        ].map((key) => [`OBSERVED_UNTRUSTED_BUILDER_${key}`, value]),
      );
      const result = shell(projection.run!, {
        ...environment,
        OBSERVED_MATERIAL_PHASE: "verify-maven",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(value);
      expect(result.stdout).toContain(
        "untrusted_builder_operation=unknown untrusted_builder_outcome=unknown untrusted_builder_observed=unknown untrusted_builder_exited=unknown untrusted_builder_signaled=unknown untrusted_builder_timed_out=unknown untrusted_builder_joined=unknown untrusted_builder_stderr_class=unknown",
      );
    },
  );
});

describe("partial material-step observation", () => {
  it("retains an entered material step when terminal observations are unavailable", () => {
    const summary = resolve(root(), "summary");
    const result = shell(projection.run!, {
      OBSERVED_MATERIAL_PHASE: "download-source",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("supervisor=unknown");
    expect(result.stdout).toContain("material_phase=download-source");
    expect(readFileSync(summary, "utf8")).toBe(result.stdout);
  });
});

describe("closed always-after projection", () => {
  it("projects file-command controller observations despite prior unavailable stdout", () => {
    const summary = resolve(root(), "summary");
    const result = shell(projection.run!, {
      OBSERVED_SUPERVISOR: "terminal",
      OBSERVED_SUPERVISOR_CODE: "1",
      OBSERVED_CONTAINED: "true",
      OBSERVED_RESIDUAL: "false",
      OBSERVED_FAILURE: "integration.controller.retire-outer-host",
      OBSERVED_STAGE: "prepareImages",
      OBSERVED_KIND: "pull-outcome-unknown",
      OBSERVED_CLEANUP: "not-attempted",
      OBSERVED_PULL_TRIGGER: "timeout",
      OBSERVED_RECONCILIATION: "failed",
      OBSERVED_MATERIAL_PHASE: "verify-maven",
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "supervisor=terminal code=1 signal=unknown contained=true residual=false",
    );
    expect(result.stdout).toContain(
      "failure=integration.controller.retire-outer-host stage=prepareImages kind=pull-outcome-unknown cleanup=not-attempted trigger=timeout reconciliation=failed",
    );
    expect(readFileSync(summary, "utf8")).toBe(result.stdout);
    expect(result.stdout).toContain("material_phase=verify-maven");
  });
  it("rejects injected controller observations and preserves diagnostic-only success", () => {
    const result = shell(projection.run!, {
      OBSERVED_SUPERVISOR: "rejected",
      OBSERVED_SUPERVISOR_CODE: "03",
      OBSERVED_CONTAINED: "true\nCANARY",
      OBSERVED_FAILURE: "$(exit 8)",
      OBSERVED_STAGE: "CANARY",
      OBSERVED_MATERIAL_PHASE: "download-source\nCANARY=secret",
      GITHUB_STEP_SUMMARY: root(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "supervisor=rejected code=unknown signal=unknown contained=unknown",
    );
    expect(result.stdout).not.toContain("CANARY");
    expect(result.stdout).not.toContain("$(exit");
    expect(result.stdout).toContain("material_phase=unknown");
  });
  it("does not block upload when its real stdout reader is closed", async () => {
    const summary = resolve(root(), "summary");
    expect(
      await closedReader(projection.run!, {
        OBSERVED_OUTCOME: "success",
        OBSERVED_ENTERED: "true",
        OBSERVED_COMMAND_STATUS: "3",
        OBSERVED_SHELL_STATUS: "0",
        GITHUB_STEP_SUMMARY: summary,
      }),
    ).toEqual({ code: 0, signal: null });
    expect(readFileSync(summary, "utf8")).toBe(
      "integration.mockserver-research.shell-observation outcome=success shell_entered=true command_status=3 shell_status=0\n",
    );
  });
  function project(values: NodeJS.ProcessEnv, summaryFailure = false) {
    const directory = root();
    const summary = summaryFailure ? directory : resolve(directory, "summary");
    const result = shell(projection.run!, {
      OBSERVED_OUTCOME: "",
      OBSERVED_ENTERED: "",
      OBSERVED_COMMAND_STATUS: "",
      OBSERVED_SHELL_STATUS: "",
      ...values,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    if (!summaryFailure)
      expect(readFileSync(summary, "utf8")).toBe(result.stdout);
    return result.stdout;
  }
  it("projects only the allowed observations without implying containment", () => {
    expect(
      project({
        OBSERVED_OUTCOME: "failure",
        OBSERVED_ENTERED: "true",
        OBSERVED_COMMAND_STATUS: "3",
        OBSERVED_SHELL_STATUS: "7",
      }),
    ).toBe(
      "integration.mockserver-research.shell-observation outcome=failure shell_entered=true command_status=3 shell_status=7\n",
    );
  });
  it("reports absent terminal observations as unknown", () => {
    expect(
      project({ OBSERVED_OUTCOME: "cancelled", OBSERVED_ENTERED: "true" }),
    ).toContain("command_status=unknown shell_status=unknown");
  });
  it.each([
    "256",
    "-1",
    "03",
    "1.0",
    "1\nsecret",
    "$(exit 8)",
    "99999999999999999999999999",
  ])("sanitizes hostile numeric input %s", (value) => {
    expect(
      project({ OBSERVED_COMMAND_STATUS: value, OBSERVED_SHELL_STATUS: value }),
    ).toContain("command_status=unknown shell_status=unknown");
  });
  it("sanitizes unknown outcomes and entered values without evaluating them", () => {
    expect(
      project({
        OBSERVED_OUTCOME: "success\ncanary",
        OBSERVED_ENTERED: "$(exit 8)",
      }),
    ).toContain("outcome=unknown shell_entered=unknown");
  });
  it("does not fail the diagnostic step when summary output fails", () => {
    expect(project({}, true)).toContain("outcome=unknown");
  });
});
