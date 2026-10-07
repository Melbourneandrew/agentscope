/** Content-free research only; these values never authorize execution or success. */
export const codexPtyResearchHints: readonly string[];
export const codexGateResearchHints: readonly string[];
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
  diagnosticVersion?: 4 | 5,
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
  diagnosticVersion?: 4 | 5,
): boolean;
