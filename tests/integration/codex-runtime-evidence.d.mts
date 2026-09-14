export function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown>;

export function boundedRequestLedger(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[];

export function codexTurnTerminalObserved(
  ledgers: readonly string[],
  expectedMessage: string,
): boolean;

export function readCodexSessionLedgers(homeDescriptor: number): string[];

export function settledCodexLedgerSnapshot(input: {
  before: Readonly<Record<string, unknown>>;
  first: Buffer;
  middle: Readonly<Record<string, unknown>>;
  second: Buffer;
  after: Readonly<Record<string, unknown>>;
}): string | null;

export function waitWithinObservationDeadline(input: {
  deadline: number;
  maximumWaitMilliseconds: number;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<void>;
