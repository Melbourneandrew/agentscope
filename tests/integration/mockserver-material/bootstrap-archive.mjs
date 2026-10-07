/** Exact archive bytes only; no signature, extraction or execution authority. */
import { createHash } from "node:crypto";
import { types } from "node:util";

export const bootstrapArchivePins = Object.freeze({
  node: Object.freeze({
    bytes: 54108748,
    sha256: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
  }),
  jdk: Object.freeze({
    bytes: 193252603,
    sha256: "3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e",
  }),
});

const fail = () => {
  throw new Error("integration.mockserver-material.bootstrap-archive");
};

export const verifyBootstrapArchive = (kind, input) => {
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(bootstrapArchivePins, kind) ||
    !types.isUint8Array(input)
  )
    fail();
  const pin = bootstrapArchivePins[kind];
  const bytes = Buffer.copyBytesFrom(input, 0, pin.bytes + 1);
  if (
    bytes.byteLength !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    fail();
  return bytes;
};
