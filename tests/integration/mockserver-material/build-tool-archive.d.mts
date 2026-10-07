/** Byte identity only, never signer, executable-tool, build or admission proof. */
export const mavenArchivePin: Readonly<{
  bytes: number;
  sha256: string;
  sha512: string;
}>;
export function verifyMavenArchiveBytes(input: Uint8Array): Buffer;
