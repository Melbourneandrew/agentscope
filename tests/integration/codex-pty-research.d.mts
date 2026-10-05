/** Content-free research only; these values never authorize execution or success. */
export const codexPtyResearchHints: readonly string[];
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
):
  | Readonly<{ outcome: string; checkpointProgressDiagnostic: string | null }>
  | undefined;
export function validUntrustedCodexPtyReceipt(value: unknown): boolean;
