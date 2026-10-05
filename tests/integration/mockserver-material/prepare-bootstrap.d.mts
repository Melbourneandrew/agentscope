/** Input verification only. Mutable bytes require reauthentication at staging. */
import type { PreparedDockerClient } from "../image-preparation.mjs";
export interface MockServerBootstrapInput {
  readonly deadline: number;
  readonly dockerClient: PreparedDockerClient;
  readonly privateRoot: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}
export function prepareMockServerBootstrap(
  input: MockServerBootstrapInput,
): Promise<
  Readonly<{
    archives: Readonly<Record<"source" | "maven" | "node" | "jdk", Buffer>>;
    verification: Readonly<{
      evidenceScope: "bootstrap-input-verification-only";
      base: string;
      commandSha256: string;
      helperSha256: string;
      verifications: readonly Readonly<{
        kind: "maven" | "node" | "jdk";
        imageId: string;
      }>[];
    }>;
  }>
>;
