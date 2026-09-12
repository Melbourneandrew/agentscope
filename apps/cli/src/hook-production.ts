import { randomBytes } from "node:crypto";

import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createOperationalStateStore,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  runResolvedTraceLifecycle,
} from "@agentscope/core";
import {
  createConfigurationProcessIdentity,
  createConfigurationStore,
} from "@agentscope/core/configuration-management";
import { createLocalResourceHomeAuthority } from "@agentscope/core/home-authority";
import {
  resolveOwnedHookHomeForCli,
  type HookEntryAuthority,
} from "@agentscope/core/hook-orchestration";
import type { PrepareCoreRetrievalRuntimeInput } from "@agentscope/core/retrieval-orchestration";
import {
  decodeCodexRootHookInput,
  mapCodexRootHookCapture,
} from "@agentscope/harness-codex";
import { bindLocalSqliteProductionReporterHome } from "@agentscope/destination-local-sqlite";

import { productionDestinationTransportExecutor } from "./destination-transport.js";
import {
  PRODUCT_DESTINATION_REGISTRY,
  requireExactProductDestinationRegistry,
} from "./product-destination-registry.js";

type ProductHookInput = {
  evidence: Uint8Array;
  hookEntryAuthority: HookEntryAuthority;
  launcher: Readonly<{ harnessType: string; homeRoot: string }>;
};

const runProductCodexHookEvidenceWith = async (
  input: ProductHookInput,
  environment: Readonly<Record<string, string | undefined>>,
  transportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"],
): Promise<void> => {
  if (input.launcher.harnessType !== "@agentscope/harness-codex")
    throw new Error("cli.hook.invalid");
  const hook = decodeCodexRootHookInput(input.evidence);
  if (hook.eventName !== "Stop") return;
  const home = resolveOwnedHookHomeForCli(input.hookEntryAuthority);
  if (home.root !== input.launcher.homeRoot)
    throw new Error("cli.hook.invalid");
  bindLocalSqliteProductionReporterHome(createLocalResourceHomeAuthority(home));
  const registry = requireExactProductDestinationRegistry(
    PRODUCT_DESTINATION_REGISTRY,
  );
  const owner = createConfigurationProcessIdentity(
    process.pid,
    `process-start-v1-${randomBytes(32).toString("hex")}`,
  );
  await runResolvedTraceLifecycle({
    configurationStore: createConfigurationStore(home, registry),
    operationalStateStore: createOperationalStateStore(home, owner),
    credentialBackendRegistry: compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter(environment),
    ]),
    transportExecutor,
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    harnessRegistryId: "codex",
    harnessVersion: {
      state: "unavailable",
      reason: "not-emitted",
      source: "process",
    },
    hookObservedUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    operationIdScope: "session-global",
    workspaceCandidates: Object.freeze([
      Object.freeze({ path: hook.workspacePath, source: "hook-payload" }),
    ]),
    gitExecutable:
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\cmd\\git.exe"
        : "/usr/bin/git",
    hookEntryAuthority: input.hookEntryAuthority,
    capture: (factory) => factory.capture(mapCodexRootHookCapture(hook)),
  });
};

export const runProductCodexHookEvidence = (
  input: ProductHookInput,
): Promise<void> =>
  runProductCodexHookEvidenceWith(
    input,
    process.env,
    productionDestinationTransportExecutor,
  );

export const runProductCodexHookEvidenceForTesting = (
  input: ProductHookInput,
  options: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    transportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"];
  }>,
): Promise<void> =>
  runProductCodexHookEvidenceWith(
    input,
    options.environment,
    options.transportExecutor,
  );
