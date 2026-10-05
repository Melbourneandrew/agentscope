export declare const classifyBuildxStderr: (value: unknown) => string;
export declare const selectCommandOutput: (value: unknown) => "text" | "binary";
export declare const serializeCommandOutput: (
  chunks: readonly Uint8Array[],
  selection: "text" | "binary",
) => string | Buffer;
