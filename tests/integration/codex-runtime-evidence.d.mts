export function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown>;

export function boundedRequestLedger(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[];

export function waitWithinObservationDeadline(input: {
  deadline: number;
  maximumWaitMilliseconds: number;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<void>;
