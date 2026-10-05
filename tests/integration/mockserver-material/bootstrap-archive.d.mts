export type BootstrapArchiveKind = "node" | "jdk";
export declare const bootstrapArchivePins: Readonly<
  Record<BootstrapArchiveKind, Readonly<{ bytes: number; sha256: string }>>
>;
export declare const verifyBootstrapArchive: (
  kind: BootstrapArchiveKind,
  input: Uint8Array,
) => Buffer;
