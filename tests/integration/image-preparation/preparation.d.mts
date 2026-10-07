export type ImagePreparationDiagnostic = Readonly<{
  primary: "none" | "pull-outcome-unknown" | "preparation-failed";
  cleanup: "none" | "private-cleanup-failed";
  trigger:
    | "unknown"
    | "transport"
    | "timeout"
    | "abort"
    | "unexpected-status"
    | "empty-events"
    | "malformed-event"
    | "daemon-error-event";
  reconciliation: "not-attempted" | "completed" | "failed";
}>;

export declare const readImagePreparationDiagnostic: (
  error: unknown,
) => ImagePreparationDiagnostic | undefined;
export declare const recordClientSetupCleanupFailure: (
  primary: unknown,
  cleanup: unknown,
) => Error;

type PullPolicy = Readonly<{
  workDeadline: number;
  reconciliationDeadline: number;
}>;
type PullInput = Readonly<{
  daemon: Readonly<{ apiVersion: string }>;
  image: string;
  platform: Readonly<{ os: string; architecture: string; variant?: string }>;
  policy: PullPolicy;
  signal?: AbortSignal;
  transport: unknown;
}>;

export declare const recordUnexpectedEngineStatus: (error: Error) => Error;
export declare const createPullOperation: (
  dependencies: Readonly<{
    engineCall: (
      context: Readonly<{
        policy: PullPolicy;
        signal: AbortSignal | undefined;
        transport: unknown;
      }>,
      request: Readonly<{
        expected: readonly number[];
        method: "POST";
        path: string;
      }>,
    ) => Promise<Readonly<{ body: Buffer }>>;
    inspectLocalImage: (
      input: Omit<PullInput, "platform" | "signal"> &
        Readonly<{ missingAllowed: true; signal: undefined }>,
    ) => Promise<unknown>;
    platformText: (platform: PullInput["platform"]) => string;
  }>,
) => (input: PullInput) => Promise<void>;

export declare const prepareImageOperation: (
  state: Readonly<{ admitPreparedSet: (value: unknown) => void }>,
  dependencies: Readonly<{
    engineTransport: (socket: unknown) => unknown;
    prepareImageSet: (input: unknown) => Promise<unknown>;
    createPrivateClientRoot: (
      options: unknown,
      deadline: number,
    ) => Readonly<{ root: string }>;
    cleanupPrivateClient: (
      owned: Readonly<{ root: string }>,
      deadline: number,
    ) => void;
  }>,
  images: readonly string[],
  options?: import("../image-preparation.mjs").PreparePinnedDockerImagesOptions,
) => Promise<unknown>;
