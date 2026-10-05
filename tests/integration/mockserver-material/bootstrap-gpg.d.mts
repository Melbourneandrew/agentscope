/** Stock-GPG output classification only; synthetic records are not proof. */
export function verifyBootstrapGpgStatus(
  kind: "maven" | "node" | "jdk",
  output: string,
  nowSeconds: number,
): Readonly<{
  primaryFingerprint: string;
  created: number;
  expiry: number;
}>;
export function verifyBootstrapGpgListing(
  kind: "maven" | "node" | "jdk",
  listing: string,
  nowSeconds: number,
): Readonly<{
  created: number;
  expiry: number;
}>;
