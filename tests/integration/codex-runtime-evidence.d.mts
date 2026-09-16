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

export function codexTurnTerminalObservedAfterBaseline(
  ledgers: readonly CodexSessionLedgerRecord[],
  baseline: readonly CodexSessionLedgerRecord[],
  expectedMessage: string,
): boolean;

export interface CodexSessionLedgerRecord {
  readonly relativePath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly content: string;
}

export function terminalObservationBeforeDeadline(input: {
  observed: boolean;
  deadline: number;
  now: () => number;
}): boolean;

export interface CodexProcessIdentity {
  readonly executable: string;
  readonly pid: number;
  readonly startIdentity: string;
}

export function sessionStartProcessSetDrained(input: {
  readonly baseline: readonly CodexProcessIdentity[];
  readonly current: readonly CodexProcessIdentity[];
  readonly codexIdentity: CodexProcessIdentity;
}): boolean;

export function readCodexSessionLedgers(homeDescriptor: number): string[];

export function readCodexSessionLedgerRecords(
  homeDescriptor: number,
): CodexSessionLedgerRecord[];

export function openLocalSqliteLifecycle(homeDescriptor: number): number;

export function localSqliteReporterSettled(
  lifecycleDescriptor: number,
): boolean;

export function settledLocalSqliteLifecycleSnapshot(input: {
  before: Readonly<Record<string, unknown>>;
  first: ReadonlyArray<Readonly<{ kind: string; name: string }>>;
  middle: Readonly<Record<string, unknown>>;
  second: ReadonlyArray<Readonly<{ kind: string; name: string }>>;
  after: Readonly<Record<string, unknown>>;
}): boolean;

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
