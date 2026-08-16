/** A versioned batch produced by an AgentScope harness after normalization. */
export interface TraceBatch<TEvent = unknown> {
  schemaVersion: 1;
  source: TraceSourceIdentity;
  events: readonly TEvent[];
}

/** Identifies the harness and native artifact that produced a batch. */
export interface TraceSourceIdentity {
  harness: string;
  harnessVersion?: string;
  sessionId: string;
  workspace?: { branch?: string; commit?: string; root?: string };
}

/** A harness-facing source; it owns native extraction, never destination I/O. */
export interface TraceSource<TEvent = unknown> {
  readonly id: string;
  collect(input: TraceCollectionInput): Promise<TraceBatch<TEvent>>;
}

export interface TraceCollectionInput {
  sessionId: string;
  workspace: string;
  artifactPaths: readonly string[];
}

/** A destination-facing reporter; it receives only normalized/redacted batches. */
export interface TraceReporter<TEvent = unknown> {
  readonly id: string;
  report(batch: TraceBatch<TEvent>): Promise<TraceReportReceipt>;
}

export interface TraceReportReceipt {
  accepted: number;
  destinationIds?: readonly string[];
}
