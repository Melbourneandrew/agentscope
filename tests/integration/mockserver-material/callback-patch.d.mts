export const callbackSourcePin: Readonly<{
  repository: string;
  commit: string;
  tree: string;
  path: string;
  blob: string;
  bytes: number;
  sha256: string;
}>;
/** Returns exact patched source only, not compiled or admitted service evidence. */
export const patchCallbackSource: (input: Uint8Array) => string;
