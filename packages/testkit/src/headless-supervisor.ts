declare const headlessSupervisorCapabilityBrand: unique symbol;

/**
 * Opaque authority for the selected native or container isolation backend.
 * Testkit runtime-authenticates it; caller data and component fixtures cannot
 * construct or mint it.
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
