/** Private finite OCI input, not a caller-controlled context registry. */
export declare const withBuildBase: <Result>(
  input: Readonly<{
    client: unknown;
    context: string;
    baseImage?: string;
    policy: Readonly<{ workDeadline: number; deadline: number }>;
    signal?: AbortSignal;
  }>,
  operation: (
    base: Readonly<{ context: string; validate: () => void }> | undefined,
  ) => Promise<Result>,
  markUncertain: () => void,
  canRemove: () => boolean,
) => Promise<Result>;
