export declare const classifyBuildxStderr: (value: unknown) => string;
export type MavenFailureObservation = Readonly<{
  disposition: "absent" | "overflow" | "ambiguous" | "unlisted" | "identified";
  exitCode: number | null;
  signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGABRT" | null;
  goal: number;
  unit: number;
  line: number;
  column: number;
  reason: number;
}>;
export type SupplierExecutionObservation = Readonly<{
  mode:
    | "dependency-research"
    | "offline-build"
    | "cache-seeding"
    | "service-offline";
  exitCode: number;
}>;
export declare const parseMavenFailureObservation: (
  value: unknown,
) => MavenFailureObservation | undefined;
export declare const createBuildStderrObservation: () => Readonly<{
  consume(chunk: Buffer): boolean;
  snapshot(): Readonly<{
    stderrClass: string;
    untrustedBootstrapStage?: string;
    untrustedBootstrapFailureFamily?: string;
    untrustedMavenFailure?: MavenFailureObservation;
    untrustedSupplierExecution?: SupplierExecutionObservation;
  }>;
}>;
export declare const selectCommandOutput: (value: unknown) => "text" | "binary";
export declare const serializeCommandOutput: (
  chunks: readonly Uint8Array[],
  selection: "text" | "binary",
) => string | Buffer;
