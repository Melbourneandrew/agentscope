import { randomBytes } from "node:crypto";

import {
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
import {
  decodeClaudeCodeRootHookInput,
  mapClaudeCodeRootHookCapture,
} from "@agentscope/harness-claude-code";
import { bindLocalSqliteProductionReporterHome } from "@agentscope/destination-local-sqlite";

import { productionDestinationTransportExecutor } from "./destination-transport.js";
import { createProductCredentialBackendRegistry } from "./product-credential-registry.js";
import {
  PRODUCT_DESTINATION_REGISTRY,
  requireExactProductDestinationRegistry,
} from "./product-destination-registry.js";

type ProductHookInput = {
  evidence: Uint8Array;
  hookEntryAuthority: HookEntryAuthority;
  launcher: Readonly<{ harnessType: string; homeRoot: string }>;
};

const projectHookEvidence = (input: ProductHookInput) => {
  if (input.launcher.harnessType === "@agentscope/harness-codex") {
    const hook = decodeCodexRootHookInput(input.evidence);
    return hook.eventName === "Stop"
      ? {
          harnessRegistryId: "codex" as const,
          operationIdScope: "session-global" as const,
          workspacePath: hook.workspacePath,
          capture: () => mapCodexRootHookCapture(hook),
        }
      : undefined;
  }
  if (input.launcher.harnessType === "@agentscope/harness-claude-code") {
    const hook = decodeClaudeCodeRootHookInput(input.evidence);
    // Recognition of a historical payload is not installation eligibility.
    if (hook.eventName === "SessionEnd") throw new Error("cli.hook.invalid");
    return {
      harnessRegistryId: "claude-code" as const,
      operationIdScope: "parent-scoped" as const,
      workspacePath: hook.workspacePath,
      capture: () => mapClaudeCodeRootHookCapture(hook),
    };
  }
  throw new Error("cli.hook.invalid");
};

const runProductHookEvidenceWith = async (
  input: ProductHookInput,
  environment: Readonly<Record<string, string | undefined>>,
  transportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"],
): Promise<void> => {
  const hook = projectHookEvidence(input);
  if (hook === undefined) return;
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
    credentialBackendRegistry:
      createProductCredentialBackendRegistry(environment),
    transportExecutor,
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    harnessRegistryId: hook.harnessRegistryId,
    harnessVersion: {
      state: "unavailable",
      reason: "not-emitted",
      source: "process",
    },
    hookObservedUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    operationIdScope: hook.operationIdScope,
    workspaceCandidates: Object.freeze([
      Object.freeze({ path: hook.workspacePath, source: "hook-payload" }),
    ]),
    gitExecutable:
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\cmd\\git.exe"
        : "/usr/bin/git",
    hookEntryAuthority: input.hookEntryAuthority,
    capture: (factory) => factory.capture(hook.capture()),
  });
};

export const runProductHookEvidence = (
  input: ProductHookInput,
): Promise<void> =>
  runProductHookEvidenceWith(
    input,
    process.env,
    productionDestinationTransportExecutor,
  );

export const runProductHookEvidenceForTesting = (
  input: ProductHookInput,
  options: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    transportExecutor: PrepareCoreRetrievalRuntimeInput["transportExecutor"];
  }>,
): Promise<void> =>
  runProductHookEvidenceWith(
    input,
    options.environment,
    options.transportExecutor,
  );
