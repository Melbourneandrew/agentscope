import type { ReporterDeadline } from "@agentscope/destinations-core";

export type LocalSqliteSearchPlan = Readonly<{
  planVersion: 1;
  sql: string;
  parameters: Readonly<Record<string, string | number>>;
  maximumRows: number;
  maximumResponseBytes: number;
  maximumWorkMilliseconds: number;
  retentionCutoffParameter: "retentionCutoffSortKey";
  snapshotToken?: string;
}>;
export type LocalSqliteGetPlan = Readonly<{
  planVersion: 1;
  sql: string;
  parameters: Readonly<{ traceId: string }>;
  maximumResponseBytes: number;
  maximumWorkMilliseconds: number;
  retentionCutoffParameter: "retentionCutoffSortKey";
}>;
export type LocalSqliteRetrievalRow = Readonly<{
  deliveryIdentity: string;
  traceId: string;
  startTimeSortKey: string;
  admissionTimeSortKey: string;
  protocolCompatibilityId: string;
  payloadUtf8: string;
  payloadSha256: string;
  payloadBytes: number;
}>;
export type LocalSqliteSearchEvidence = Readonly<{
  rows: readonly LocalSqliteRetrievalRow[];
  responseByteLimitReached: boolean;
  retentionCutoffSortKey: string;
  snapshotToken: string;
}>;
export type LocalSqliteGetEvidence = Readonly<{
  row: LocalSqliteRetrievalRow | undefined;
  retentionCutoffSortKey: string;
}>;
export type LocalSqliteRetrieverDatabase = Readonly<{
  search: (
    plan: LocalSqliteSearchPlan,
    signal: AbortSignal,
    deadline?: ReporterDeadline,
  ) => Promise<LocalSqliteSearchEvidence>;
  get: (
    plan: LocalSqliteGetPlan,
    signal: AbortSignal,
    deadline?: ReporterDeadline,
  ) => Promise<LocalSqliteGetEvidence>;
}>;
