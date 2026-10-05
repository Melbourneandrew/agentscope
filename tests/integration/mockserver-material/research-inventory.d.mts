export type MockServerResearchFile = Readonly<{
  path: string;
  type: "file";
  bytes: number;
  mode: 384 | 420;
  sha256: string;
}>;
export type MockServerResearchDirectory = Readonly<{
  path: string;
  type: "directory";
  mode: 448 | 493;
}>;
/** Untrusted observations only; not an authenticated dependency/cache authority. */
export function parseMockServerResearchInventory(input: Buffer): Readonly<{
  bytes: number;
  sha256: string;
  observedBytes: number;
  record: Readonly<{
    schemaVersion: 1;
    evidenceScope: "untrusted-cache-and-jar-research-only";
    consumedDependencyClosure: "not-proved";
    caches: readonly (MockServerResearchFile | MockServerResearchDirectory)[];
    artifact: MockServerResearchFile;
  }>;
}>;
