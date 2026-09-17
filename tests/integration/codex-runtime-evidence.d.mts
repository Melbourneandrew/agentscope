export function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown>;

export function boundedRequestLedger(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[];

export function classifyCodexStopHookCommand(input: {
  afterRead?: () => void;
  directoryDescriptor: number;
  directoryPath: string;
}):
  | "completed"
  | "timeout"
  | "spawn_error"
  | "stdin_error"
  | "wait_error"
  | undefined;

export function codexSessionStartMediationUpperBoundMilliseconds(input: {
  afterRead?: () => void;
  directoryDescriptor: number;
  directoryPath: string;
}): number | undefined;

export function codexTurnTerminalObserved(
  ledgers: readonly string[],
  expectedMessage: string,
): boolean;

export function codexTurnTerminalObservedAfterBaseline(
  ledgers: readonly CodexSessionLedgerRecord[],
  baseline: readonly CodexSessionLedgerRecord[],
  expectedMessage: string,
): boolean;

export function codexTurnTerminalIdAfterBaseline(
  ledgers: readonly CodexSessionLedgerRecord[],
  baseline: readonly CodexSessionLedgerRecord[],
  expectedMessage: string,
): string | null;

export function codexSessionIdentity(
  ledgers: readonly CodexSessionLedgerRecord[],
): string;

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

export function recordTerminalObservationBeforeDeadline(input: {
  deadline: number;
  now: () => number;
  record: () => void;
}): void;

export function inspectDiagnosticBeforeDeadline<T>(input: {
  deadline: number;
  now: () => number;
  inspect: () => T;
}): T;

export function classifyTraceSearchRecordsBeforeDeadline(input: {
  records: Array<{
    summaries?: Array<{
      harness?: string;
      locator?: { traceId?: string };
    }>;
  }>;
  deadline: number;
  now: () => number;
  record: (phase: string) => void;
}): {
  harness?: string;
  locator?: { traceId?: string };
} | null;

export function publishTerminalCompletionBeforeDeadline(input: {
  deadline: number;
  now: () => number;
  record: () => void;
  publish: () => Promise<void>;
}): Promise<void>;

export function traceSummaryBeforeDeadline<T>(input: {
  summary: T;
  deadline: number;
  now: () => number;
}): T;

export function readCodexSessionLedgers(homeDescriptor: number): string[];

export function readCodexSessionLedgerRecords(
  homeDescriptor: number,
): CodexSessionLedgerRecord[];

export function openLocalSqliteLifecycle(homeDescriptor: number): number;

export function openOperationalStateHealth(homeDescriptor: number): number;

export function localSqliteReporterSettled(
  lifecycleDescriptor: number,
): boolean;

export interface LocalSqliteAcceptanceBaseline {
  readonly nextSequence: number;
  readonly losses: Readonly<{
    diagnostics: number;
    health: number;
    checkpoints: number;
  }>;
  readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
  readonly health: readonly Readonly<Record<string, unknown>>[];
  readonly checkpoints: readonly Readonly<Record<string, unknown>>[];
}

export function localSqliteAcceptanceBaseline(
  healthDescriptor: number,
): LocalSqliteAcceptanceBaseline;

export function localSqliteAcceptanceObservedAfterBaseline(
  healthDescriptor: number,
  baseline: LocalSqliteAcceptanceBaseline,
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

export function waitForModelRequestBeforeDeadline(input: {
  deadline: number;
  now: () => number;
  request: (signal: AbortSignal) => Promise<readonly unknown[]>;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<readonly unknown[]>;
