// Test-only scheduler adversary: move only the timer callback past the fixed
// monotonic cutoff. The raw ingress gate must still reject the late bytes.
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...arguments_) =>
  originalSetTimeout(
    callback,
    callback?.name === "enforceCutoff" ? milliseconds + 1_500 : milliseconds,
    ...arguments_,
  );
