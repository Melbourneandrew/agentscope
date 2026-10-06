import { types } from "node:util";
import type { CredentialResolutionContext } from "@agentscope/core";

type Input = Pick<
  NodeJS.ReadStream,
  | "isTTY"
  | "isRaw"
  | "readableFlowing"
  | "setRawMode"
  | "pause"
  | "resume"
  | "on"
  | "removeListener"
>;
type Output = Pick<
  NodeJS.WriteStream,
  "isTTY" | "write" | "once" | "removeListener"
>;
const invalid = () => new Error("cli.credential-input.unavailable");
const eraseCodePoint = (bytes: number[]) => {
  const removed = bytes.pop();
  if (removed !== undefined && (removed & 0xc0) === 0x80) {
    while (bytes.length && (bytes[bytes.length - 1]! & 0xc0) === 0x80)
      bytes.pop();
    bytes.pop();
  }
};
const decodeSecret = (bytes: number[]) => {
  try {
    const secret = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Uint8Array.from(bytes));
    return secret && !/[\r\n]/u.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
};
const expired = (context: CredentialResolutionContext) =>
  context.signal.aborted ||
  context.expiresAtMonotonicMilliseconds === undefined ||
  performance.now() >= context.expiresAtMonotonicMilliseconds;

export const readHiddenCredentialForCli = (
  slot: string,
  context: CredentialResolutionContext,
  input: Input = process.stdin,
  output: Output = process.stderr,
): Promise<string> => {
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(slot) ||
    slot.length > 64 ||
    !input.isTTY ||
    !output.isTTY ||
    expired(context)
  )
    return Promise.reject(invalid());
  return new Promise((resolve, reject) => {
    const raw = input.isRaw === true;
    const flowing = input.readableFlowing === true;
    const bytes: number[] = [];
    let terminal = false;
    let promptCompleted = false;
    const finish = (secret?: string) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", fail);
      input.removeListener("data", data);
      input.removeListener("end", fail);
      input.removeListener("close", fail);
      input.removeListener("error", fail);
      output.removeListener?.("error", fail);
      let restored = false;
      try {
        input.setRawMode(raw);
        if (flowing) input.resume();
        else input.pause();
        restored = true;
      } catch {
        /* Refuse success when terminal stream restoration is unproved. */
      }
      bytes.fill(0);
      if (secret !== undefined && restored && !expired(context))
        resolve(secret);
      else reject(invalid());
    };
    const fail = () => {
      finish();
    };
    const data = (value: unknown) => {
      if (terminal) return;
      if (!promptCompleted || expired(context) || !types.isUint8Array(value)) {
        fail();
        return;
      }
      const chunk = Buffer.copyBytesFrom(value, 0, 8195);
      if (chunk.length > 8194) {
        fail();
        return;
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]!;
        if (byte === 3 || byte === 4 || byte === 0) {
          fail();
          return;
        }
        if (byte === 13 || byte === 10) {
          if (chunk.subarray(index + 1).some((entry) => entry !== 10)) {
            fail();
            return;
          }
          const secret = decodeSecret(bytes);
          if (secret === undefined) fail();
          else finish(secret);
          return;
        }
        if (byte === 8 || byte === 127) {
          eraseCodePoint(bytes);
        } else {
          if (byte < 32 || bytes.length >= 8192) {
            fail();
            return;
          }
          bytes.push(byte);
        }
      }
    };
    const timeout = setTimeout(
      fail,
      Math.max(0, context.expiresAtMonotonicMilliseconds! - performance.now()),
    );
    try {
      if (expired(context)) {
        fail();
        return;
      }
      context.signal.addEventListener("abort", fail, { once: true });
      input.pause();
      input.on("end", fail);
      input.on("close", fail);
      input.on("error", fail);
      output.once?.("error", fail);
      input.setRawMode(true);
      input.on("data", data);
      output.write(`${slot}: `, (error) => {
        if (error) {
          // Node reports a failed write callback before its error event. Keep
          // that event observed even if input already expired; no new wait.
          output.once("error", () => undefined);
          fail();
          return;
        }
        promptCompleted = true;
        try {
          if (expired(context)) fail();
          else if (!terminal) input.resume();
        } catch {
          fail();
        }
      });
    } catch {
      fail();
    }
  });
};
