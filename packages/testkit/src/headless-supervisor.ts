declare const headlessSupervisorCapabilityBrand: unique symbol;

/**
 * Opaque authority consumed by the bounded supervisor kernel. The authority is
 * runtime-authenticated inside Testkit; caller data cannot construct or mint it.
 */
export type HeadlessSupervisorCapability = Readonly<{
  [headlessSupervisorCapabilityBrand]: true;
}>;

export type HeadlessSupervisorExecutionOptions = Readonly<{
  signal?: AbortSignal;
}>;

export class HeadlessSupervisorError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.code = code;
  }
}
