import type { Buffer } from "node:buffer";

/** Returns owned, exact source archive bytes only; no extraction/execution. */
export const verifyMockServerSourceArchive: (input: Uint8Array) => Buffer;
