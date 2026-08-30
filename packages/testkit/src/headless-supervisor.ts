declare const headlessSupervisorCapabilityBrand: unique symbol;

const defineOwnProperty = Object.defineProperty;

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
  declare public readonly code: string;

  public constructor(code: string) {
    super(code);
    defineOwnProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
  }
}

// The public diagnostic type is immutable before an importer can obtain it.
// In particular, callers cannot redirect `super()` through a carrier
// constructor and smuggle caller-controlled message content into a fixed
// kernel diagnostic.
Object.freeze(HeadlessSupervisorError.prototype);
Object.freeze(HeadlessSupervisorError);
