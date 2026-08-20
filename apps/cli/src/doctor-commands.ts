import type { Command } from "commander";
import { DOCTOR_FINDING_CODES } from "@agentscope/core";
import { z } from "zod";

import type { CliOperationResult } from "./cli-contract.js";
import {
  defineCliCommandModule,
  type RuntimeCliCommandModule,
} from "./command-runtime.js";

export const doctorSeveritySchema = z.enum(["info", "warning", "error"]);
export const CLI_DOCTOR_FINDING_CODES = Object.freeze([
  "doctor.pipeline-health.unavailable",
  "doctor.pipeline-health.absent",
  "doctor.pipeline-health.retained",
  "doctor.harness.unavailable",
  "doctor.harness.installed",
  "doctor.harness.absent",
  "doctor.harness.unsupported",
  "doctor.harness.indeterminate",
  "doctor.hook.ready",
  "doctor.hook.unchanged",
  "doctor.hook.conflict",
  "doctor.hook.unsupported",
  "doctor.hook.recovery-required",
  "doctor.hook.invalid",
  "doctor.hook.unavailable",
  "doctor.destination.available",
  "doctor.destination.unavailable",
  "doctor.destination.probe-unsupported",
  "doctor.git.available",
  "doctor.git.detached",
  "doctor.git.workspace-unavailable",
  "doctor.git.repository-unavailable",
] as const);
export const doctorFindingCodeSchema = z.enum([
  ...DOCTOR_FINDING_CODES,
  ...CLI_DOCTOR_FINDING_CODES,
]);
export const doctorEvidenceStateSchema = z.enum([
  "valid",
  "missing",
  "invalid",
  "unsupported",
  "unavailable",
  "clean",
  "active",
  "owner-unknown",
  "recoverable",
  "reconciliation-required",
  "conflict",
  "available",
  "locked",
  "denied",
  "malformed",
  "lock-active",
  "lock-owner-unknown",
  "lock-recoverable",
  "lock-reconciliation-required",
  "lock-invalid",
  "lock-unavailable",
  "absent",
  "retained",
  "installed",
  "indeterminate",
  "unchanged",
  "ready",
  "recovery-required",
  "probe-unsupported",
  "detached",
  "workspace-unavailable",
  "repository-unavailable",
]);
export const doctorActionSchema = z.enum([
  "none",
  "configure",
  "retry",
  "install-harness",
  "migrate-harness",
  "unlock-credential-store",
  "inspect-credential-mutation",
  "repair-configuration-transaction",
  "repair-operational-state-lock",
  "reconcile-recovery-claim",
  "inspect-configuration-conflict",
  "inspect-destination",
]);
export const doctorEvidenceSchema = z.strictObject({
  count: z.number().int().nonnegative().max(4_096).nullable(),
  freshness: z.enum(["current", "retained", "unavailable"]),
  lossCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  scope: z.enum([
    "configuration",
    "transaction",
    "credential-mutation",
    "credential",
    "operational-state",
    "pipeline-health",
    "harness",
    "hook",
    "destination",
    "git",
  ]),
  state: doctorEvidenceStateSchema,
  subject: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9@._-]+$/u)
    .nullable(),
  version: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
    .nullable(),
});
export type CliDoctorEvidence = Readonly<z.infer<typeof doctorEvidenceSchema>>;

export const doctorFindingSchema = z.strictObject({
  code: doctorFindingCodeSchema,
  evidence: doctorEvidenceSchema,
  severity: doctorSeveritySchema,
  suggestedAction: doctorActionSchema,
});
export type CliDoctorFinding = Readonly<z.infer<typeof doctorFindingSchema>>;

export const doctorRepairSchema = z.strictObject({
  action: z.enum([
    "repair-configuration-transaction",
    "repair-operational-state-lock",
  ]),
  state: z.enum(["planned", "applied", "unavailable"]),
});
export type CliDoctorRepair = Readonly<z.infer<typeof doctorRepairSchema>>;

// 64 connections × 16 credential slots, five Core state findings, one pipeline
// finding, two findings for each of 32 harnesses, one per connection, and Git.
export const MAXIMUM_DOCTOR_FINDINGS = 1_159;

export const doctorReportSchema = z.strictObject({
  findings: z.array(doctorFindingSchema).max(MAXIMUM_DOCTOR_FINDINGS),
  fixed: z.boolean(),
  repairs: z.array(doctorRepairSchema).max(2),
  summary: z.strictObject({
    errors: z.number().int().nonnegative().max(MAXIMUM_DOCTOR_FINDINGS),
    information: z.number().int().nonnegative().max(MAXIMUM_DOCTOR_FINDINGS),
    warnings: z.number().int().nonnegative().max(MAXIMUM_DOCTOR_FINDINGS),
  }),
});
type ParsedDoctorReport = z.infer<typeof doctorReportSchema>;
export type CliDoctorReport = Readonly<
  Omit<ParsedDoctorReport, "findings" | "repairs" | "summary"> & {
    findings: readonly CliDoctorFinding[];
    repairs: readonly CliDoctorRepair[];
    summary: Readonly<ParsedDoctorReport["summary"]>;
  }
>;

export type CliDoctorServices = Readonly<{
  doctor: (
    input: Readonly<{
      fix: boolean;
      presentPlan: (value: CliDoctorReport) => Promise<void>;
    }>,
  ) =>
    | CliOperationResult<CliDoctorReport>
    | Promise<CliOperationResult<CliDoctorReport>>;
}>;

const fixRequested = (command: Command): boolean => {
  const options: unknown = command.opts();
  if (typeof options !== "object" || options === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(options, "fix");
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value === true
    : false;
};

const findingLine = (finding: CliDoctorFinding): string =>
  `${finding.severity.toUpperCase()} [${finding.code}] ${finding.evidence.state}; action=${finding.suggestedAction}`;

const doctorModule = defineCliCommandModule<
  CliDoctorServices,
  Readonly<{ fix: boolean }>,
  CliDoctorReport
>({
  configure: (command: Command) => {
    command.option(
      "--fix",
      "apply only proof-bound dead-owner configuration and operational-lock repairs",
    );
  },
  execute: (services: CliDoctorServices, input, context) =>
    services.doctor({ ...input, presentPlan: context.presentPlan }),
  human: (value) => [
    `Doctor: ${value.summary.errors} error(s), ${value.summary.warnings} warning(s), ${value.summary.information} informational finding(s).`,
    ...value.findings.map(findingLine),
    ...value.repairs.map(
      (repair) => `Repair ${repair.action}: ${repair.state}`,
    ),
  ],
  id: "doctor",
  inputSchema: z.strictObject({ fix: z.boolean() }),
  machineRecords: (value) => [value],
  outputSchema: doctorReportSchema,
  readInput: (command: Command) => ({ fix: fixRequested(command) }),
});

export const doctorCommandModules: readonly RuntimeCliCommandModule[] =
  Object.freeze([doctorModule]);
