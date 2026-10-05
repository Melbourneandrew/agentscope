/** Private material filesystem operations, not execution authority. */
export interface MaterialDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
}
export function exactDirectory(path: string): MaterialDirectoryIdentity;
export function sameDirectory(identity: MaterialDirectoryIdentity): void;
export function writeExclusive(path: string, bytes: Uint8Array): void;
export function readMaterialSource(
  path: string,
): Readonly<{ bytes: Buffer; sha256: string }>;
