import { performance } from "node:perf_hooks";

const resolutionContexts = new WeakSet<object>();

export type CredentialResolutionContext = Readonly<{
  context: "interactive" | "hook-equivalent" | "hook";
  signal: AbortSignal;
  expiresAtMonotonicMilliseconds?: number;
}>;

export class CredentialAdapterError extends Error {
  public readonly code = "core.credential.invalid";

  public constructor() {
    super("core.credential.invalid");
    this.name = "CredentialAdapterError";
  }
}

export const createCredentialResolutionContext = (
  context: CredentialResolutionContext["context"],
  signal: AbortSignal,
  expiresAtMonotonicMilliseconds?: number,
): CredentialResolutionContext => {
  if (
    !["interactive", "hook-equivalent", "hook"].includes(context) ||
    !(signal instanceof AbortSignal) ||
    (expiresAtMonotonicMilliseconds !== undefined &&
      (typeof expiresAtMonotonicMilliseconds !== "number" ||
        !Number.isFinite(expiresAtMonotonicMilliseconds) ||
        expiresAtMonotonicMilliseconds < 0))
  )
    throw new CredentialAdapterError();
  const value = Object.freeze({
    context,
    signal,
    ...(expiresAtMonotonicMilliseconds === undefined
      ? {}
      : { expiresAtMonotonicMilliseconds }),
  });
  resolutionContexts.add(value);
  return value;
};

export const isCredentialResolutionContext = (
  value: unknown,
): value is CredentialResolutionContext =>
  typeof value === "object" && value !== null && resolutionContexts.has(value);

export const credentialResolutionExpired = (
  context: CredentialResolutionContext,
): boolean =>
  context.signal.aborted ||
  (context.expiresAtMonotonicMilliseconds !== undefined &&
    performance.now() >= context.expiresAtMonotonicMilliseconds);

// The original branded lifetime guards mutation entry and observed settlement.
// It neither creates a timer nor claims that an unjoined operation stopped.
export const invokeCredentialMutationForCore = async <T>(
  context: CredentialResolutionContext,
  invoke: (
    boundary: Pick<
      CredentialResolutionContext,
      "signal" | "expiresAtMonotonicMilliseconds"
    >,
  ) => Promise<T>,
): Promise<T> => {
  if (
    !isCredentialResolutionContext(context) ||
    credentialResolutionExpired(context)
  )
    throw new CredentialAdapterError();
  const result = await invoke(
    Object.freeze({
      signal: context.signal,
      ...(context.expiresAtMonotonicMilliseconds === undefined
        ? {}
        : {
            expiresAtMonotonicMilliseconds:
              context.expiresAtMonotonicMilliseconds,
          }),
    }),
  );
  if (credentialResolutionExpired(context)) throw new CredentialAdapterError();
  return result;
};
