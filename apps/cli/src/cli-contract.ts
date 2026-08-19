import { z } from "zod";

export const cliOutputModeSchema = z.enum(["human", "json", "jsonl"]);
export type CliOutputMode = z.infer<typeof cliOutputModeSchema>;

export const cliExitCategorySchema = z.enum([
  "success",
  "usage",
  "not-found",
  "conflict",
  "unavailable",
  "permission-denied",
  "internal-error",
]);
export type CliExitCategory = z.infer<typeof cliExitCategorySchema>;

export const CLI_EXIT_CODES = Object.freeze({
  conflict: 4,
  "internal-error": 70,
  "not-found": 3,
  "permission-denied": 6,
  success: 0,
  unavailable: 5,
  usage: 2,
} satisfies Readonly<Record<CliExitCategory, number>>);

const diagnosticFactSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.null(),
]);

const diagnosticFactsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/u),
    diagnosticFactSchema,
  )
  .superRefine((facts, context) => {
    if (Object.keys(facts).length > 16) {
      context.addIssue({ code: "custom", message: "too many facts" });
    }
  });

export const cliDiagnosticSchema = z.strictObject({
  category: cliExitCategorySchema.exclude(["success"]),
  code: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
  facts: diagnosticFactsSchema.optional(),
});
export type CliDiagnostic = Readonly<z.infer<typeof cliDiagnosticSchema>>;

export type CliOperationResult<Value> =
  | Readonly<{ status: "success"; value: Value }>
  | Readonly<{
      diagnostic: CliDiagnostic;
      status: "partial";
      value: Value;
    }>
  | Readonly<{ diagnostic: CliDiagnostic; status: "failure" }>;

export const INTERNAL_DIAGNOSTIC: CliDiagnostic = Object.freeze({
  category: "internal-error",
  code: "cli.internal",
});

export const INVALID_INPUT_DIAGNOSTIC: CliDiagnostic = Object.freeze({
  category: "usage",
  code: "cli.input.invalid",
});

export const INVALID_OUTPUT_MODE_DIAGNOSTIC: CliDiagnostic = Object.freeze({
  category: "usage",
  code: "cli.output.unsupported",
});
