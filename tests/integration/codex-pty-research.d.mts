/** Content-free research only; these values never authorize execution or success. */
export const codexPtyResearchHints: readonly string[];
export const codexGateResearchHints: readonly string[];
export type AdapterReportedFailure = Readonly<{
  stage: number;
  cutoffExpired: boolean;
  workerJoined: boolean | null;
  watchdogJoined: boolean | null;
  leaseReleased: boolean | null;
}>;
export function classifyCodexCollectedChildFailure(
  observation: unknown,
  options: {
    acceptTraceSearchUnavailable?: boolean;
    traceGetDiagnostic?: boolean;
  },
  retainObservation: boolean,
): {
  message: string;
  adapterReportedFailure: AdapterReportedFailure | undefined;
};
export function projectAdapterReportedFailure(
  value: unknown,
): AdapterReportedFailure | undefined;
export function encodeAdapterReportedFailureMarker(
  predicate: unknown,
  runId: unknown,
  value: unknown,
): string | undefined;
export function decodeAdapterReportedFailureMarker(
  content: unknown,
  runId: unknown,
): AdapterReportedFailure | undefined;
export function extractAdapterReportedFailure(
  output: unknown,
  runId: unknown,
): AdapterReportedFailure | undefined;
export function createCodexFailureResearchRecord(
  plan: { runId: string; scenarioId: string },
  output: unknown,
  receipt: unknown,
  error: unknown,
  dependencies: readonly [
    (output: unknown) => string | undefined,
    (output: unknown) => string | undefined,
    (output: unknown) => string | undefined,
    typeof projectUntrustedCodexPtyReceipt,
    typeof extractAdapterReportedFailure,
    (
      fixture: unknown,
      container: unknown,
      scenario: string,
    ) => string | undefined,
  ],
): {
  diagnosticVersion: 6;
  untrustedConfigHint: string | null;
  untrustedGateHint: string | null;
  untrustedPtyHint: string | null;
  untrustedPtyReceipt: ReturnType<
    typeof projectUntrustedCodexPtyReceipt
  > | null;
  adapterReportedFailure: AdapterReportedFailure | null;
  exitPair: string | null;
};
export const codexResearchDependencies: Parameters<
  typeof createCodexFailureResearchRecord
>[4];
export function createCodexModelControlRequest(options: {
  httpRequest: typeof import("node:http").request;
  agent: import("node:http").Agent;
  headers: Readonly<Record<string, string>>;
  socketPath: string;
  deadline: () => number;
  gateCutoff: () => number | undefined;
  now: () => number;
  observe?: (hint: string) => void;
}): (
  path: string,
  method: string,
  value?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export function codexArmPtyResearchHint(
  error: unknown,
  stage?: unknown,
): string;
export function extractUntrustedCodexPtyHint(
  output: unknown,
): string | undefined;
export function failedCodexSessionStartHint(home: string): Promise<string>;
export function projectUntrustedCodexPtyReceipt(
  receipt: unknown,
  diagnosticVersion?: 4 | 5 | 6,
):
  | Readonly<{
      outcome: string;
      checkpointProgressDiagnostic: string | null;
      pumpFailureDiagnostic?: Readonly<{
        operation:
          | "read"
          | "write"
          | "emulator"
          | "resize"
          | "eof"
          | "signal"
          | "checkpoint-namespace"
          | "checkpoint-freeze"
          | "checkpoint-classify"
          | "checkpoint-release"
          | "checkpoint-publish"
          | "pump-other";
        category:
          | "observer-read"
          | "observer-identity"
          | "transport"
          | "geometry"
          | "checkpoint-witness"
          | "execution-deadline"
          | "unknown";
        originalExecutionDeadlineExhausted: boolean;
      }> | null;
    }>
  | undefined;
export function validUntrustedCodexPtyReceipt(
  value: unknown,
  diagnosticVersion?: 4 | 5 | 6,
): boolean;
