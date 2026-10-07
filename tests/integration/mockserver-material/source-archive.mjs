/** Verify the checked-in source archive input; never a service admission. */
import { createHash } from "node:crypto";
import { types } from "node:util";

const sourceArchiveBytes = 31_447_709;
const sourceArchiveSha256 =
  "c364e63e1461e283a3db5d5ce4546f65070ff49b737cd71c0e3999e42f24c1b2";

export const verifyMockServerSourceArchive = (input) => {
  if (!types.isUint8Array(input))
    throw new Error("integration.mockserver-material.source-archive");
  const bytes = Buffer.copyBytesFrom(input, 0, sourceArchiveBytes + 1);
  if (
    bytes.byteLength !== sourceArchiveBytes ||
    createHash("sha256").update(bytes).digest("hex") !== sourceArchiveSha256
  )
    throw new Error("integration.mockserver-material.source-archive");
  // An owned copy prevents mutation between verification and bounded parsing.
  // This contains dormant upstream source, not an executable service receipt.
  return bytes;
};
