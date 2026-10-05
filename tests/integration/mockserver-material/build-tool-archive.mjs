/** Exact Maven archive bytes only; no signer or executable-tool authority. */
import { createHash } from "node:crypto";
import { types } from "node:util";

export const mavenArchivePin = Object.freeze({
  bytes: 9_395_475,
  sha256: "5af3b743dd8b876b5c45da33b676251e5f1687712644abb4ee519ca56e1d89ce",
  sha512:
    "ed41650d42485cfc243fad22158caf9cbb5dc408ce7a09ddb94dd42a019de929ca43065bfa450612cf12bf78b5cafa3884b96c090de326ff590448c933454af3",
});

const fail = () => {
  throw new Error("integration.mockserver-material.build-tool-archive");
};

export const verifyMavenArchiveBytes = (input) => {
  if (!types.isUint8Array(input)) fail();
  const bytes = Buffer.copyBytesFrom(input, 0, mavenArchivePin.bytes + 1);
  if (
    bytes.byteLength !== mavenArchivePin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !==
      mavenArchivePin.sha256 ||
    createHash("sha512").update(bytes).digest("hex") !== mavenArchivePin.sha512
  )
    fail();
  return bytes;
};
