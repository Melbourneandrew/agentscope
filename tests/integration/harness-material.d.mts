import type {
  NpmHarnessMaterial,
  SignedManifestHarnessMaterial,
  VerifiedHarnessMaterial,
} from "./src/harness-material.js";
import type { PreparedDockerClient } from "./image-preparation.mjs";

declare const tokenBrand: unique symbol;
export type PreparedNpmHarnessMaterial = Readonly<{
  authorityKind: "authenticated-harness-material";
  authorityVersion: 1;
  [tokenBrand]: true;
}>;

export declare const prepareNpmHarnessMaterial: (
  input: Readonly<{
    evidenceId: string;
    dockerClient: PreparedDockerClient;
    material: NpmHarnessMaterial;
    maximumMilliseconds: number;
    privateRoot: string;
    runId: string;
    signal: AbortSignal;
  }>,
) => Promise<PreparedNpmHarnessMaterial>;

export declare const inspectPreparedNpmHarnessMaterial: (
  token: PreparedNpmHarnessMaterial,
) => VerifiedHarnessMaterial;

export declare const stagePreparedNpmHarnessMaterial: (
  token: PreparedNpmHarnessMaterial,
  target: string,
) => void;

export declare const retirePreparedNpmHarnessMaterial: (
  token: PreparedNpmHarnessMaterial,
) => void;

export type PreparedHarnessMaterial = PreparedNpmHarnessMaterial;

export declare const prepareHarnessMaterial: (
  input: Readonly<{
    evidenceId: string;
    dockerClient: PreparedDockerClient;
    material: NpmHarnessMaterial | SignedManifestHarnessMaterial;
    maximumMilliseconds: number;
    privateRoot: string;
    runId: string;
    signal: AbortSignal;
  }>,
) => Promise<PreparedHarnessMaterial>;

export declare const inspectPreparedHarnessMaterial: (
  token: PreparedHarnessMaterial,
) => VerifiedHarnessMaterial;

export declare const stagePreparedHarnessMaterial: (
  token: PreparedHarnessMaterial,
  target: string,
) => void;

export declare const retirePreparedHarnessMaterial: (
  token: PreparedHarnessMaterial,
) => void;
