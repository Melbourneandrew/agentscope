import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createMacosKeychainCredentialAdapter,
  type CredentialBackendRegistry,
} from "@agentscope/core";

// Candidate execution eligibility only. Release/native-session admission is
// separate; no Windows or Linux native backend is selected for this alpha.
export const createProductCredentialBackendRegistry = (
  environment: object,
): CredentialBackendRegistry =>
  compileCredentialBackendRegistry([
    createCiEnvironmentCredentialAdapter(environment),
    ...(process.platform === "darwin"
      ? [createMacosKeychainCredentialAdapter()]
      : []),
  ]);
