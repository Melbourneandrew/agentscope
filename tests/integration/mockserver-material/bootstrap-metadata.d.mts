/** Byte identity only; never signer, executable, build or admission proof. */
export type BootstrapMetadataKind =
  | "node-checksums"
  | "node-signed-checksums"
  | "node-key"
  | "temurin-checksum"
  | "temurin-signature"
  | "temurin-key";
export const bootstrapMetadataPins: Readonly<
  Record<BootstrapMetadataKind, Readonly<{ bytes: number; sha256: string }>>
>;
export function verifyBootstrapMetadata(
  kind: BootstrapMetadataKind,
  input: Uint8Array,
): Buffer;
