import {
  createTraceSearchCursor,
  type TraceCursorBinding,
  type TraceSearchCursor,
  validateTraceCursorBinding,
} from "./retrieval-cursor.js";
import {
  isRetrieverSearchPage,
  type PartialResultReason,
  type RetrievalConsistency,
  type RetrieverSearchPage,
  type TraceSummary,
} from "./retrieval-results.js";

declare const traceSearchPageBrand: unique symbol;

export type TraceSearchPage = Readonly<{
  summaries: readonly TraceSummary[];
  state: "exhaustive" | "continuation" | "partial";
  partialReason?: PartialResultReason;
  nextCursor?: TraceSearchCursor;
  consistency: RetrievalConsistency;
  exactTotal?: number;
  readonly [traceSearchPageBrand]: true;
}>;

const pageRegistry = new WeakSet<object>();

export class TraceSearchPageError extends Error {
  public readonly code = "destination.trace-search-page.invalid";

  public constructor() {
    super("destination.trace-search-page.invalid");
    this.name = "TraceSearchPageError";
  }
}

const invalid = (): never => {
  throw new TraceSearchPageError();
};

export const createTraceSearchPage = (
  page: RetrieverSearchPage,
  binding: TraceCursorBinding,
): TraceSearchPage => {
  try {
    if (!isRetrieverSearchPage(page)) return invalid();
    const validatedBinding = validateTraceCursorBinding(binding);
    if (
      page.summaries.some(
        (summary) =>
          summary.locator.connectionId !== validatedBinding.connectionId ||
          summary.locator.destinationType !== validatedBinding.destinationType,
      )
    )
      return invalid();
    const nextCursor =
      page.continuationToken === undefined
        ? undefined
        : createTraceSearchCursor(validatedBinding, page.continuationToken);
    const result = Object.freeze({
      summaries: page.summaries,
      state: page.state,
      ...(page.partialReason === undefined
        ? {}
        : { partialReason: page.partialReason }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      consistency: page.consistency,
      ...(page.exactTotal === undefined ? {} : { exactTotal: page.exactTotal }),
    }) as TraceSearchPage;
    pageRegistry.add(result);
    return result;
  } catch {
    return invalid();
  }
};

export const isTraceSearchPage = (value: unknown): value is TraceSearchPage =>
  typeof value === "object" && value !== null && pageRegistry.has(value);
