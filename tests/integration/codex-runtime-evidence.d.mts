export function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown>;

export function boundedRequestLedger(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[];
