/** Bounded exporter research data, never an image or service authority. */
import { types } from "node:util";

const blockBytes = 512;
export const maximumBuildArtifactBytes = 8 * 1024 * 1024;
const maximumArchiveBytes = maximumBuildArtifactBytes + 20 * blockBytes;
const fail = () => {
  throw new Error("integration.images.build.artifact");
};
const zero = (bytes) => bytes.every((byte) => byte === 0);
const text = (bytes) => {
  const end = bytes.indexOf(0);
  const length = end === -1 ? bytes.length : end;
  if (!zero(bytes.subarray(length))) fail();
  if (bytes.subarray(0, length).some((byte) => byte < 32 || byte > 126)) fail();
  return bytes.subarray(0, length).toString("ascii");
};
const octal = (bytes) => {
  const value = bytes.toString("latin1");
  if (!/^[0-7]+[\0 ]*$/u.test(value)) fail();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail();
  return number;
};

/** Accept one regular root-owned material.json; do not extract any member. */
export const readBuildArtifactTar = (input) => {
  if (!types.isUint8Array(input)) fail();
  const bytes = Buffer.copyBytesFrom(input, 0, maximumArchiveBytes + 1);
  if (
    bytes.length > maximumArchiveBytes ||
    bytes.length < 3 * blockBytes ||
    bytes.length % blockBytes !== 0
  )
    fail();
  const header = bytes.subarray(0, blockBytes);
  const expectedChecksum = octal(header.subarray(148, 156));
  let checksum = 0;
  for (let index = 0; index < blockBytes; index += 1)
    checksum += index >= 148 && index < 156 ? 32 : header[index];
  const size = octal(header.subarray(124, 136));
  if (
    checksum !== expectedChecksum ||
    text(header.subarray(0, 100)) !== "material.json" ||
    octal(header.subarray(100, 108)) !== 0o644 ||
    octal(header.subarray(108, 116)) !== 0 ||
    octal(header.subarray(116, 124)) !== 0 ||
    size < 1 ||
    size > maximumBuildArtifactBytes ||
    (header[156] !== 0 && header[156] !== 48) ||
    !zero(header.subarray(157, 257)) ||
    text(header.subarray(257, 263)) !== "ustar" ||
    header[263] !== 48 ||
    header[264] !== 48 ||
    !zero(header.subarray(345, blockBytes))
  )
    fail();
  // Validate otherwise unused numeric and name fields rather than ignoring
  // malformed records. Owner names carry no authority; numeric IDs above do.
  octal(header.subarray(136, 148));
  text(header.subarray(265, 297));
  text(header.subarray(297, 329));
  if (
    octal(header.subarray(329, 337)) !== 0 ||
    octal(header.subarray(337, 345)) !== 0
  )
    fail();
  const end = blockBytes + size;
  const trailer = blockBytes + Math.ceil(size / blockBytes) * blockBytes;
  if (trailer + 2 * blockBytes > bytes.length || !zero(bytes.subarray(end)))
    fail();
  return Buffer.from(bytes.subarray(blockBytes, end));
};
