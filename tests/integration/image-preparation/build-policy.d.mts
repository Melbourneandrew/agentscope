export type BuildNetwork = "default" | "none";
export type BuildOutput = "image" | "evidence-tar";
export declare const createBuildArchive: (
  context: string,
  options: unknown,
) => Buffer;
export declare const selectBuildOutput: (value: unknown) => BuildOutput;
export declare const validBuildInput: (options: unknown) => boolean;
export declare const imageBuildPolicy: (
  image: string,
  milliseconds: number,
) => unknown;
export declare const unavailableProcessDiagnostic: (
  failure: unknown,
) => Readonly<Record<string, unknown>>;
export declare const settledBuildFailure: (
  authority: unknown,
  failure: unknown,
) => Error;
export declare const buildPhaseFailure: (
  error: unknown,
  phase: string,
  retainedCodes: readonly string[],
) => unknown;
export declare const selectBuildNetwork: (value: unknown) => BuildNetwork;
export declare const builderNetworkFor: (
  selection: BuildNetwork,
) => "bridge" | "none";
export declare const buildArgumentsFor: (
  options: Readonly<{
    buildArguments: Readonly<Record<string, string>>;
    buildNetwork: BuildNetwork;
    buildOutput?: BuildOutput;
    builder: string;
    dockerfile: string;
    labels: Readonly<Record<string, string>>;
    platform: Readonly<{ os: string; architecture: string; variant?: string }>;
    tag?: string;
  }>,
) => string[];
