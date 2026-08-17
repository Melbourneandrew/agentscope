export class BinaryTextError extends Error {
  public constructor() {
    super("protocol.codec.invalid");
    this.name = "BinaryTextError";
  }
}

const invalid = (): never => {
  throw new BinaryTextError();
};

const standardAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const bytesToHex = (bytes: Uint8Array) => {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
};

export const hexToBytes = (value: string, length: number) => {
  if (value.length !== length * 2 || !/^[\da-fA-F]+$/u.test(value)) invalid();
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
};

export const bytesToBase64 = (bytes: Uint8Array) => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += standardAlphabet[(bits >>> 18) & 63];
    output += standardAlphabet[(bits >>> 12) & 63];
    output += b === undefined ? "=" : standardAlphabet[(bits >>> 6) & 63];
    output += c === undefined ? "=" : standardAlphabet[bits & 63];
  }
  return output;
};

export const base64ToBytes = (value: string) => {
  if (!/^[A-Za-z\d+/_-]*={0,2}$/u.test(value)) invalid();
  const padding = value.length - value.replace(/=+$/u, "").length;
  const unpadded = value
    .replace(/=+$/u, "")
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  if (unpadded.length % 4 === 1) invalid();
  if (
    padding > 0 &&
    (value.length % 4 !== 0 || padding !== (4 - (unpadded.length % 4)) % 4)
  )
    invalid();
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const output = new Uint8Array(
    (padded.length / 4) * 3 -
      (padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0),
  );
  let outputIndex = 0;
  for (let index = 0; index < padded.length; index += 4) {
    const a = standardAlphabet.indexOf(padded[index]!);
    const b = standardAlphabet.indexOf(padded[index + 1]!);
    const c =
      padded[index + 2] === "="
        ? 0
        : standardAlphabet.indexOf(padded[index + 2]!);
    const d =
      padded[index + 3] === "="
        ? 0
        : standardAlphabet.indexOf(padded[index + 3]!);
    /* v8 ignore next -- the closed lexical preflight and alphabet normalization make this defensive. */
    if (a < 0 || b < 0 || c < 0 || d < 0) invalid();
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    /* v8 ignore next -- canonical base64 allocation always has the first output byte for each quartet. */
    if (outputIndex < output.length) output[outputIndex++] = bits >>> 16;
    if (outputIndex < output.length) output[outputIndex++] = (bits >>> 8) & 255;
    if (outputIndex < output.length) output[outputIndex++] = bits & 255;
  }
  if (bytesToBase64(output).replace(/=+$/u, "") !== padded.replace(/=+$/u, ""))
    invalid();
  return output;
};
