import {
  isRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";

export type RedactedTraceSink = (trace: RedactedCanonicalTrace) => undefined;

export type RedactedTraceSinkInvocation = "rejected" | "returned";

const promiseResolve = Promise.resolve.bind(Promise) as (
  value: unknown,
) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured before caller-controlled prototype mutation.
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;

/* v8 ignore start -- valid-brand return handling can only be reached through
   Core; Core unit tests and the dist/esbuild artifact verifier cover it. */
const attachPromiseReaction = (value: unknown): boolean => {
  try {
    void reflectApply(promiseThen, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
};

const observeUnexpectedReturn = (value: unknown): void => {
  if (attachPromiseReaction(value)) return;
  try {
    const observed = promiseResolve(value);
    void attachPromiseReaction(observed);
  } catch {
    // Hostile thenables are rejected without exposing their thrown content.
  }
};
/* v8 ignore stop */

export const invokeRedactedTraceSink = (
  sink: RedactedTraceSink,
  trace: RedactedCanonicalTrace,
): RedactedTraceSinkInvocation => {
  try {
    /* v8 ignore else -- a valid brand can only be minted by Core; the Core
       lifecycle and dist/esbuild artifact verifier exercise this authority path. */
    if (!isRedactedCanonicalTrace(trace)) return "rejected";
    /* v8 ignore start -- see authority-path explanation above. */
    const runtimeSink = sink as unknown as (
      value: RedactedCanonicalTrace,
    ) => unknown;
    const returned = runtimeSink(trace);
    if (returned !== undefined) observeUnexpectedReturn(returned);
    return returned === undefined ? "returned" : "rejected";
    /* v8 ignore stop */
  } catch {
    /* v8 ignore next -- exercised through Core with a genuine branded value. */
    return "rejected";
  }
};
