import { describe, expect, it } from "vitest";

import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import {
  MAXIMUM_DOCTOR_FINDINGS,
  type CliDoctorReport,
  type CliDoctorServices,
} from "./doctor-commands.js";
import { runCli } from "./program.js";

const report = (state: "planned" | "applied" | null): CliDoctorReport =>
  Object.freeze({
    findings: Object.freeze([
      Object.freeze({
        code: "doctor.configuration.valid",
        evidence: Object.freeze({
          count: null,
          freshness: "current" as const,
          lossCount: null,
          scope: "configuration" as const,
          state: "valid",
          subject: null,
          version: null,
        }),
        severity: "info" as const,
        suggestedAction: "none" as const,
      }),
    ]),
    fixed: state === "applied",
    repairs: Object.freeze(
      state === null
        ? []
        : [
            Object.freeze({
              action: "repair-configuration-transaction" as const,
              state,
            }),
          ],
    ),
    summary: Object.freeze({ errors: 0, information: 1, warnings: 0 }),
  });

const run = async (
  arguments_: readonly string[],
  doctor: CliDoctorServices["doctor"],
) => {
  const captured = createCapturedOutput();
  const exitCode = await runCli(arguments_, {
    output: captured.output,
    services: { doctor } satisfies CliDoctorServices,
    version: "1.2.3",
  });
  return { ...captured, exitCode };
};

describe("agentscope doctor command", () => {
  it("renders the maximum valid Doctor finding inventory", async () => {
    const finding = report(null).findings[0];
    expect(finding).toBeDefined();
    const findings = Object.freeze(
      Array.from({ length: MAXIMUM_DOCTOR_FINDINGS }, () =>
        Object.freeze({
          ...finding!,
          evidence: Object.freeze({ ...finding!.evidence }),
        }),
      ),
    );
    const maximumReport = Object.freeze({
      ...report(null),
      findings,
      summary: Object.freeze({
        errors: 0,
        information: MAXIMUM_DOCTOR_FINDINGS,
        warnings: 0,
      }),
    });

    const result = await run(["doctor", "--output", "json"], () => ({
      status: "success",
      value: maximumReport,
    }));

    expect(result.exitCode).toBe(0);
    const rendered = JSON.parse(result.stdout.join("")) as {
      records: [{ findings: unknown[]; summary: { information: number } }];
    };
    expect(rendered.records[0].findings).toHaveLength(MAXIMUM_DOCTOR_FINDINGS);
    expect(rendered.records[0].summary.information).toBe(
      MAXIMUM_DOCTOR_FINDINGS,
    );
  });

  it("documents the exact safe repair boundary", async () => {
    const result = await run(["doctor", "--help"], () => ({
      status: "success",
      value: report(null),
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join(" ").replace(/\s+/gu, " ")).toContain(
      "proof-bound dead-owner configuration and operational-lock repairs",
    );
  });

  it("renders one immutable human report without requesting repair", async () => {
    let received: unknown;
    const result = await run(["doctor"], (input) => {
      received = input;
      return { status: "success", value: report(null) };
    });

    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({ fix: false });
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("")).toContain(
      "INFO [doctor.configuration.valid] valid; action=none",
    );
  });

  it("rejects finding codes outside the closed Doctor vocabulary", async () => {
    const invalidReport = {
      ...report(null),
      findings: [
        {
          ...report(null).findings[0],
          code: "doctor.synthetic.future",
        },
      ],
    } as unknown as CliDoctorReport;
    const result = await run(["doctor", "--output", "json"], () => ({
      status: "success",
      value: invalidReport,
    }));

    expect(result.exitCode).toBe(70);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join(" ")).toContain("cli.internal");
  });

  it("presents the --fix plan on stderr before the final machine report", async () => {
    const result = await run(
      ["doctor", "--fix", "--output", "json"],
      async ({ fix, presentPlan }) => {
        expect(fix).toBe(true);
        await presentPlan(report("planned"));
        return { status: "success", value: report("applied") };
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.join(""))).toMatchObject({
      command: "agentscope doctor",
      records: [{ repairs: [{ state: "planned" }] }],
      schema: "agentscope.cli.plan.v1",
    });
    expect(JSON.parse(result.stdout.join(""))).toMatchObject({
      completion: "complete",
      records: [{ fixed: true, repairs: [{ state: "applied" }] }],
    });
  });

  it("renders human repair records", async () => {
    const result = await run(["doctor", "--fix"], async ({ presentPlan }) => {
      await presentPlan(report("planned"));
      return { status: "success", value: report("applied") };
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.join("")).toContain(
      "Repair repair-configuration-transaction: planned",
    );
    expect(result.stdout.join("")).toContain(
      "Repair repair-configuration-transaction: applied",
    );
  });
});
