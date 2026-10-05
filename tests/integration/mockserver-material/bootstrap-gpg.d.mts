/** Stock-GPG output classification only; synthetic records are not proof. */
export function authenticateBootstrapGpgInputForTesting(
  kind: "maven" | "node" | "jdk",
  name: "key" | "signature" | "manifest",
  path: string,
): void;
export function runBootstrapGpgVerification(
  kind: "maven" | "node" | "jdk",
  execute: typeof import("node:child_process").execFile.__promisify__,
): Promise<void>;
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
