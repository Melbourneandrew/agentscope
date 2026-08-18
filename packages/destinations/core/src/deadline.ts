declare const reporterDeadlineBrand: unique symbol;

export type ReporterDeadline = Readonly<{
  expiresAtMonotonicMilliseconds: number;
  readonly [reporterDeadlineBrand]: true;
}>;

const deadlineRegistry = new WeakSet<object>();
const monotonicNow = performance.now.bind(performance);

export const MAXIMUM_REPORTER_TIMEOUT_MILLISECONDS = 60_000;

export class ReporterDeadlineError extends Error {
  public readonly code = "destination.reporter-deadline.invalid";

  public constructor() {
    super("destination.reporter-deadline.invalid");
    this.name = "ReporterDeadlineError";
  }
}

export const createReporterDeadline = (
  timeoutMilliseconds: number,
): ReporterDeadline => {
  if (
    !Number.isFinite(timeoutMilliseconds) ||
    timeoutMilliseconds < 0 ||
    timeoutMilliseconds > MAXIMUM_REPORTER_TIMEOUT_MILLISECONDS
  )
    throw new ReporterDeadlineError();
  const deadline = Object.freeze({
    expiresAtMonotonicMilliseconds: monotonicNow() + timeoutMilliseconds,
  }) as ReporterDeadline;
  deadlineRegistry.add(deadline);
  return deadline;
};

export const isReporterDeadline = (value: unknown): value is ReporterDeadline =>
  typeof value === "object" && value !== null && deadlineRegistry.has(value);

export const reporterDeadlineRemainingMilliseconds = (
  deadline: ReporterDeadline,
): number => {
  if (!isReporterDeadline(deadline)) throw new ReporterDeadlineError();
  return Math.max(0, deadline.expiresAtMonotonicMilliseconds - monotonicNow());
};
