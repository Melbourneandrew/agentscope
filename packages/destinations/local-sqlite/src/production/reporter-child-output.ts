import type { ChildProcess } from "node:child_process";

import {
  decodeLocalSqliteReporterChildReady,
  decodeLocalSqliteReporterChildResult,
  type LocalSqliteReporterChildResult,
} from "./reporter-child-protocol.js";

export const readLocalSqliteReporterChildMessages = (
  child: ChildProcess,
  nonce: string,
): Readonly<{
  ready: Promise<ReturnType<typeof decodeLocalSqliteReporterChildReady>>;
  result: Promise<LocalSqliteReporterChildResult | undefined>;
}> => {
  let buffer = Buffer.alloc(0);
  let resolveReady!: (
    value: ReturnType<typeof decodeLocalSqliteReporterChildReady>,
  ) => void;
  let resolveResult!: (
    value: LocalSqliteReporterChildResult | undefined,
  ) => void;
  const ready = new Promise<
    ReturnType<typeof decodeLocalSqliteReporterChildReady>
  >((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<LocalSqliteReporterChildResult | undefined>(
    (resolve) => {
      resolveResult = resolve;
    },
  );
  let sawReady = false;
  let sawResult = false;
  child.stdout?.on("data", (value: Buffer | Uint8Array) => {
    /* v8 ignore next -- result settlement is terminal and late stdout is
       deliberately discarded before any parse or allocation. */
    if (sawResult) return;
    /* v8 ignore next -- Node child stdout has no encoding and therefore emits
       Buffer; Uint8Array conversion is retained for the declared stream type. */
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > 4_096) {
      sawResult = true;
      resolveReady(undefined);
      resolveResult(undefined);
      return;
    }
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      if (!sawReady) {
        sawReady = true;
        const parsed = decodeLocalSqliteReporterChildReady(line);
        resolveReady(parsed?.nonce === nonce ? parsed : undefined);
        if (parsed?.nonce !== nonce) {
          sawResult = true;
          resolveResult(undefined);
        }
        continue;
      }
      /* v8 ignore else -- the terminal-data guard above and single-threaded
         line loop make sawResult false for the sole result line. */
      if (!sawResult) {
        sawResult = true;
        const parsed = decodeLocalSqliteReporterChildResult(line);
        resolveResult(parsed?.nonce === nonce ? parsed : undefined);
      }
    }
  });
  child.once("exit", () => {
    if (!sawReady) {
      sawReady = true;
      resolveReady(undefined);
    }
    if (!sawResult) {
      sawResult = true;
      resolveResult(undefined);
    }
  });
  /* v8 ignore start -- post-spawn stream/process errors are totalized by the
     exit listener and bounded teardown; this duplicate listener is defensive. */
  child.once("error", () => {
    if (!sawReady) {
      sawReady = true;
      resolveReady(undefined);
    }
    if (!sawResult) {
      sawResult = true;
      resolveResult(undefined);
    }
  });
  /* v8 ignore stop */
  return Object.freeze({ ready, result });
};
