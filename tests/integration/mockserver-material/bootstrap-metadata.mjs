/** Exact public bootstrap metadata only; no signer or executable authority. */
import { createHash } from "node:crypto";
import { types } from "node:util";

export const bootstrapMetadataPins = Object.freeze({
  "node-checksums": Object.freeze({
    bytes: 3777,
    sha256: "d67cdb735b1764bf5b553a0d9b067ed861b91a4d934afc20442c04f5234b55db",
  }),
  "node-signed-checksums": Object.freeze({
    bytes: 4659,
    sha256: "7be3cb73033671928c386b58e325e6ce724736a530910675cf300ba0bbc839c6",
  }),
  "node-key": Object.freeze({
    bytes: 3159,
    sha256: "4e615a57f63967ec40481be2fe6d57b39698257f31843ffe79af82d12a1806a2",
  }),
  "temurin-checksum": Object.freeze({
    bytes: 118,
    sha256: "355528c6d0728db298aa55e0b4f9be9ed617c83edd3c1dea7cd73a4525b92365",
  }),
  "temurin-signature": Object.freeze({
    bytes: 310,
    sha256: "6dee7b777982c477b1bbea4c729f3cac6404cece853ee924dc77e6b9daaa6154",
  }),
  "temurin-key": Object.freeze({
    bytes: 1793,
    sha256: "a46d5d3ab75c3c86dddf1bfd2957a067a24b1c6b2d2ed2bc69294bf970c5160b",
  }),
});

const fail = () => {
  throw new Error("integration.mockserver-material.bootstrap-metadata");
};

export const verifyBootstrapMetadata = (kind, input) => {
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(bootstrapMetadataPins, kind) ||
    !types.isUint8Array(input)
  )
    fail();
  const pin = bootstrapMetadataPins[kind];
  const bytes = Buffer.copyBytesFrom(input, 0, pin.bytes + 1);
  if (
    bytes.byteLength !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    fail();
  return bytes;
};
