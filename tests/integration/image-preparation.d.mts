export interface PreparePinnedDockerImagesOptions {
  maximumPreparationMilliseconds?: number;
  teardownMilliseconds?: number;
  dockerExecutable?: string;
  dockerArgumentsPrefix?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  closeBarrier?: () => Promise<void>;
}

export interface PreparedDockerImage {
  image: string;
  localImageDigest: string;
}

export declare const classifyProcessGroupState: (
  output: string,
  processGroup: number,
) => "absent" | "zombie-only" | "live" | "unavailable";

export declare const preparePinnedDockerImages: (
  images: readonly string[],
  options?: PreparePinnedDockerImagesOptions,
) => Promise<PreparedDockerImage[]>;

export declare const publishPreparedImageEvidence: (
  target: string,
  evidence: unknown,
) => void;

export declare const IMAGE_PREPARATION_LIMITS: Readonly<{
  maximumPreparationMilliseconds: number;
  maximumTeardownMilliseconds: number;
  maximumCommandOutputBytes: number;
}>;
