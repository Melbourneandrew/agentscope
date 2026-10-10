import type { MockServerBootstrapInput } from "./prepare-bootstrap.mjs";
import type { prepareMockServerBootstrap } from "./prepare-bootstrap.mjs";
/** Ordinary supplier research only; no cache reuse, build or service admission. */
export function researchMockServerSupplier(
  input: MockServerBootstrapInput,
): Promise<
  Readonly<{
    evidenceScope: "untrusted-cache-and-jar-research-only";
    inventory: Buffer;
    bootstrapVerification: Awaited<
      ReturnType<typeof prepareMockServerBootstrap>
    >["verification"];
  }>
>;
/** Fresh same-builder offline package; no research inventory is used as input. */
export function prepareMockServerService(
  input: MockServerBootstrapInput,
  service: Readonly<{
    tag: string;
    privateKey: Buffer;
    jwks: Buffer;
    expectations: Buffer;
  }>,
): Promise<
  Readonly<{
    imageId: string;
    tag: string;
    bootstrapVerification: Awaited<
      ReturnType<typeof prepareMockServerBootstrap>
    >["verification"];
  }>
>;
