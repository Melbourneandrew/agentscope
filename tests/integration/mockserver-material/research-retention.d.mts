import type { MockServerResearchRequest } from "../src/mockserver-research-request.js";
export type MockServerResearchProvenance = Readonly<{
  request: Extract<MockServerResearchRequest, { kind: "supplier" }>;
  sourceTree: string;
  controllerAuthority: string;
  runToken: string;
  manifestIdentity: string;
  preparedEvidenceSha256: string;
  bootstrapVerificationSha256: string;
  recipeSourcesSha256: string;
}>;
export type MockServerResearchStage = Readonly<{
  started: number;
  finished: number;
  deadline: number;
  clientSettlement: "closed-and-registered-for-outer-retirement";
}>;
export type MockServerResearchRetained = Readonly<{
  directory: string;
  inventorySha256: string;
  receiptSha256: string;
  evidenceScope: "untrusted-cache-and-jar-research-only";
}>;
export function retainMockServerResearch(
  input: Readonly<{
    parent: string;
    inventory: Buffer;
    provenance: MockServerResearchProvenance;
    stage: MockServerResearchStage;
    deadline: number;
    signal: AbortSignal;
  }>,
): MockServerResearchRetained;
export function verifyMockServerResearch(
  input: Readonly<{
    parent: string;
    deadline: number;
    signal: AbortSignal;
  }> &
    (
      | {
          expectedProvenance: MockServerResearchProvenance;
          expectedSource?: never;
        }
      | {
          expectedSource: Pick<
            MockServerResearchProvenance,
            | "request"
            | "sourceTree"
            | "manifestIdentity"
            | "recipeSourcesSha256"
          >;
          expectedProvenance?: never;
        }
    ),
): MockServerResearchRetained;
