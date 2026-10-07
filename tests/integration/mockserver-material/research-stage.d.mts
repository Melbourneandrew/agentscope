import type {
  MockServerResearchProvenance,
  MockServerResearchStage,
} from "./research-retention.mjs";
export type MockServerResearchObservation = Readonly<{
  inventory: Buffer;
  provenance: MockServerResearchProvenance;
  stage: MockServerResearchStage;
}>;
export function mockServerResearchRecipeDigest(): string;
export function runMockServerResearchStage(
  input: Readonly<{
    request: MockServerResearchProvenance["request"];
    sourceTree: string;
  }>,
): Promise<MockServerResearchObservation>;
