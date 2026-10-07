import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  compareStableSemver,
  createOwnedHarnessHookInvocation,
  parseStableSemver,
  type HarnessInstallationPlanInput,
  type HarnessInstallationPlanner,
  type HarnessTargetDecision,
  type HarnessTargetInspection,
  type HarnessDirectoryInspection,
} from "@agentscope/harnesses-core";
import {
  codexHarnessDescriptor,
  createCodexInstallationPlanner,
} from "@agentscope/harness-codex";
import {
  claudeCodeDescriptor,
  createClaudeCodeInstallationPlanner,
  type ClaudeCodeDialectAuthority,
  type ClaudeCodePluginInventory,
} from "@agentscope/harness-claude-code";

import { createOwnedHookLauncherArtifacts } from "./hook-launcher.js";
import type { ProductHarnessReadGuard } from "./product-harness-probe-files.js";
export type { ProductHarnessReadGuard } from "./product-harness-probe-files.js";
import {
  selectClaudePluginCacheRecord,
  selectClaudePluginLoadingPath,
  type ClaudePluginCacheElection,
} from "./claude-plugin-inventory.js";
import {
  snapshotClaudePlugin as snapshotPlugin,
  snapshotClaudePluginInventory as snapshotInventory,
} from "./claude-plugin-selection.js";
import {
  claudeSettingsDirectoriesAgree,
  claudeDirectoryDependencies,
  selectClaudeCanonicalLocalRootFromHeld,
  type ClaudeSettingsDirectorySelection,
} from "./claude-managed-settings.js";

const CONFIGURATION_MODE = 0o600;
const LAUNCHER_MODE = 0o700;
const releaseIdentityPattern = /^[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

type ProductHarnessInstallationCommon = Readonly<{
  agentscopeHome: string;
  hookConfigurationPath: string;
  hookDeadlineMilliseconds: number;
  machineEntryPath: string;
  mutationDirectory: string;
  nodeExecutable: string;
  operation: "install" | "migrate" | "uninstall";
  releaseIdentity: string;
}>;

export type ProductHarnessInstallationInput = ProductHarnessInstallationCommon &
  (
    | Readonly<{ harness?: "codex" }>
    | Readonly<{
        harness: "claude-code";
        dialectAuthority: ClaudeCodeDialectAuthority;
        pluginInventory: ClaudeCodePluginInventory | null;
        readGuards: readonly ProductHarnessReadGuard[];
        cacheElections?: readonly ClaudePluginCacheElection[];
        settingsDirectorySelections?: readonly ClaudeSettingsDirectorySelection[];
        localSettingsElection?: Readonly<{
          cwd: string;
          candidate: string;
          realHome: string | null;
          canonical: Readonly<{
            pluginInventory: ClaudeCodePluginInventory | null;
            cacheElections?: readonly ClaudePluginCacheElection[];
          }>;
        }>;
      }>
  );

const equalBytes = (left: Uint8Array | null, right: Uint8Array): boolean => {
  if (left === null || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < right.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

type PriorLauncherMetadata = Readonly<{
  launcherSha256: string;
  releaseIdentity: string;
}>;

/* eslint-disable complexity -- canonical prior-launcher metadata is one closed ownership grammar and must validate atomically. */
const priorLauncherMetadata = (
  bytes: Uint8Array | null,
  input: ProductHarnessInstallationInput,
  current: ReturnType<typeof createOwnedHookLauncherArtifacts>,
): PriorLauncherMetadata | undefined => {
  try {
    if (bytes === null || bytes.byteLength > 65_536) return undefined;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(parsed);
    const keys = [
      "contractVersion",
      "harnessDigest",
      "harnessType",
      "hookDeadlineMilliseconds",
      "launcherPath",
      "launcherSha256",
      "machineEntryPath",
      "mode",
      "nodeExecutable",
      "releaseIdentity",
    ];
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      ) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))
    )
      return undefined;
    const value = Object.fromEntries(
      keys.map((key) => [key, descriptors[key]?.value as unknown]),
    );
    if (
      value.contractVersion !== current.metadata.contractVersion ||
      value.harnessDigest !== current.metadata.harnessDigest ||
      value.harnessType !== current.metadata.harnessType ||
      value.hookDeadlineMilliseconds !== input.hookDeadlineMilliseconds ||
      value.launcherPath !== current.launcherPath ||
      typeof value.launcherSha256 !== "string" ||
      !digestPattern.test(value.launcherSha256) ||
      typeof value.machineEntryPath !== "string" ||
      !isAbsolute(value.machineEntryPath) ||
      resolve(value.machineEntryPath) !== value.machineEntryPath ||
      typeof value.nodeExecutable !== "string" ||
      !isAbsolute(value.nodeExecutable) ||
      resolve(value.nodeExecutable) !== value.nodeExecutable ||
      value.mode !== LAUNCHER_MODE ||
      typeof value.releaseIdentity !== "string" ||
      !releaseIdentityPattern.test(value.releaseIdentity)
    )
      return undefined;
    const prior = createOwnedHookLauncherArtifacts({
      agentscopeHome: input.agentscopeHome,
      harnessType: current.metadata.harnessType,
      hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
      machineEntryPath: value.machineEntryPath,
      nodeExecutable: value.nodeExecutable,
      platform: "posix",
      releaseIdentity: value.releaseIdentity,
    });
    if (
      prior.launcherPath !== current.launcherPath ||
      prior.metadataPath !== current.metadataPath ||
      !equalBytes(bytes, prior.metadataBytes) ||
      prior.metadata.launcherSha256 !== value.launcherSha256
    )
      return undefined;
    return Object.freeze({
      launcherSha256: value.launcherSha256,
      releaseIdentity: value.releaseIdentity,
    });
  } catch {
    return undefined;
  }
};
/* eslint-enable complexity */

const priorReleaseIsAdmissible = (
  operation: ProductHarnessInstallationInput["operation"],
  priorRelease: string,
  currentRelease: string,
): boolean => {
  if (operation === "uninstall") return true;
  const prior = parseStableSemver(priorRelease);
  const current = parseStableSemver(currentRelease);
  return (
    prior !== undefined &&
    current !== undefined &&
    compareStableSemver(prior, current) <= 0
  );
};

const ownedFileDecision = (
  operation: "install" | "migrate" | "uninstall",
  target: HarnessTargetInspection,
  bytes: Uint8Array,
  mode: 0o600 | 0o700,
): HarnessTargetDecision => {
  if (!target.exists)
    return operation === "uninstall"
      ? Object.freeze({ kind: "unchanged" as const })
      : Object.freeze({ bytes, kind: "replace" as const, mode });
  if (!equalBytes(target.bytes, bytes) || target.mode !== mode)
    return Object.freeze({ kind: "conflict" as const });
  return operation === "uninstall"
    ? Object.freeze({ kind: "remove" as const })
    : Object.freeze({ kind: "unchanged" as const });
};

const configuredFileDecision = (
  planner: HarnessInstallationPlanner,
  target: HarnessTargetInspection,
): HarnessTargetDecision => {
  const decision = planner(target);
  if (decision.kind === "unchanged")
    return target.exists && target.mode !== CONFIGURATION_MODE
      ? Object.freeze({ kind: "conflict" as const })
      : decision;
  if (decision.kind === "replace" || decision.kind === "replace-overlap")
    return Object.freeze({ ...decision, mode: CONFIGURATION_MODE });
  return decision;
};

const snapshotReadGuards = (
  values: readonly ProductHarnessReadGuard[],
): readonly ProductHarnessReadGuard[] => {
  const guards = values.map((guard) => Object.freeze({ ...guard }));
  const paths = new Set<string>();
  for (const guard of guards) {
    if (paths.has(guard.targetPath))
      throw new Error("cli.harness.plugin-inventory-unavailable");
    paths.add(guard.targetPath);
  }
  return Object.freeze(guards);
};

const snapshotElections = (
  elections: readonly ClaudePluginCacheElection[] | undefined,
) =>
  elections?.map((election) =>
    Object.freeze({
      ...(election.directoryPaths === undefined
        ? {}
        : { directoryPaths: Object.freeze([...election.directoryPaths]) }),
      candidates: Object.freeze(
        election.candidates.map((candidate) =>
          Object.freeze({
            ...candidate,
            ...(candidate.loading === undefined
              ? {}
              : {
                  loading: Object.freeze({
                    ...candidate.loading,
                    paths: Object.freeze([...candidate.loading.paths]),
                    ...(candidate.loading.versionRoots === undefined
                      ? {}
                      : {
                          versionRoots: Object.freeze(
                            candidate.loading.versionRoots.map((root) =>
                              Object.freeze({
                                ...root,
                                paths: Object.freeze([...root.paths]),
                              }),
                            ),
                          ),
                        }),
                  }),
                }),
            plugin:
              candidate.plugin === null
                ? null
                : snapshotPlugin(candidate.plugin),
          }),
        ),
      ),
    }),
  );

const electionDirectoryPaths = (
  elections: readonly ClaudePluginCacheElection[] | undefined,
): readonly string[] =>
  Object.freeze(
    Array.from(
      new Set(
        elections?.flatMap(
          (election) =>
            election.directoryPaths ??
            election.candidates.flatMap((candidate) =>
              candidate.loading === undefined
                ? [candidate.installPath]
                : [
                    ...candidate.loading.paths,
                    ...(candidate.loading.versionRoots?.flatMap((root) => [
                      root.parentPath,
                      ...root.paths,
                    ]) ?? []),
                  ],
            ),
        ) ?? [],
      ),
    ),
  );

const selectedPluginInventory = (
  inventory: ClaudeCodePluginInventory,
  elections: readonly ClaudePluginCacheElection[] | undefined,
  directories: readonly HarnessDirectoryInspection[],
): ClaudeCodePluginInventory => {
  if (elections === undefined) return inventory;
  return Object.freeze({
    ...inventory,
    installedPlugins: Object.freeze(
      elections.map((election) => {
        const index = selectClaudePluginCacheRecord(
          election.candidates.map((candidate) => candidate.installPath),
          directories,
        );
        if (index === undefined)
          throw new Error("cli.harness.plugin-inventory-unavailable");
        const candidate = election.candidates[index]!;
        const paths = candidate.loading?.paths ?? [candidate.installPath];
        const selected = selectClaudePluginLoadingPath(
          paths,
          directories,
          candidate.loading?.versionRoots,
          candidate.loading?.localPath,
        );
        if (
          selected === undefined ||
          selected !==
            (candidate.loading?.selectedPath ?? candidate.installPath) ||
          candidate.plugin === null
        )
          throw new Error("cli.harness.plugin-inventory-unavailable");
        return candidate.plugin;
      }),
    ),
  });
};

const installationArtifacts = (input: ProductHarnessInstallationInput) => {
  const descriptor =
    input.harness === "claude-code"
      ? claudeCodeDescriptor
      : codexHarnessDescriptor;
  return Object.freeze({
    invocation: createOwnedHarnessHookInvocation({
      agentscopeHome: input.agentscopeHome,
      harnessType: descriptor.harnessType,
      hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
      platform: "posix",
    }),
    launcher: createOwnedHookLauncherArtifacts({
      agentscopeHome: input.agentscopeHome,
      harnessType: descriptor.harnessType,
      hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
      machineEntryPath: input.machineEntryPath,
      nodeExecutable: input.nodeExecutable,
      platform: "posix",
      releaseIdentity: input.releaseIdentity,
    }),
  });
};

const installationTargetPaths = (
  launcher: ReturnType<typeof createOwnedHookLauncherArtifacts>,
  configurationPath: string,
  guards: readonly ProductHarnessReadGuard[],
): readonly string[] =>
  Object.freeze([
    ...new Set([
      // Read-only callbacks precede owned decisions without a second inspection.
      ...guards
        .map((guard) => guard.targetPath)
        .filter(
          (path) =>
            path !== launcher.metadataPath &&
            path !== launcher.launcherPath &&
            path !== configurationPath,
        ),
      launcher.metadataPath,
      launcher.launcherPath,
      configurationPath,
    ]),
  ]);

const installationPlanningContext = (
  input: ProductHarnessInstallationInput,
) => {
  const claude = input.harness === "claude-code";
  const { invocation, launcher } = installationArtifacts(input);
  const inventory =
    claude && input.pluginInventory !== null
      ? snapshotInventory(input.pluginInventory)
      : undefined;
  const localElection =
    input.harness === "claude-code" && input.localSettingsElection !== undefined
      ? Object.freeze({
          cwd: input.localSettingsElection.cwd,
          candidate: input.localSettingsElection.candidate,
          realHome: input.localSettingsElection.realHome,
          inventory:
            input.localSettingsElection.canonical.pluginInventory === null
              ? undefined
              : snapshotInventory(
                  input.localSettingsElection.canonical.pluginInventory,
                ),
          elections: snapshotElections(
            input.localSettingsElection.canonical.cacheElections,
          ),
        })
      : undefined;
  const effectiveUid =
    typeof process.geteuid === "function" ? process.geteuid() : null;
  const elections =
    input.harness === "claude-code"
      ? snapshotElections(input.cacheElections)
      : undefined;
  const { settingsSelections, directoryPaths } = claudeDirectoryDependencies(
    input.harness === "claude-code" ? input.settingsDirectorySelections : [],
    [
      ...electionDirectoryPaths(elections),
      ...electionDirectoryPaths(localElection?.elections),
    ],
  );
  const codexPlanner = claude
    ? undefined
    : createCodexInstallationPlanner(input.operation, invocation);
  const guards =
    input.harness === "claude-code" ? snapshotReadGuards(input.readGuards) : [];
  return Object.freeze({
    claude,
    invocation,
    launcher,
    inventory,
    localElection,
    effectiveUid,
    elections,
    settingsSelections,
    directoryPaths,
    codexPlanner,
    guards,
  });
};

const configurationPlannerFromHeld = (
  input: ProductHarnessInstallationInput,
  context: ReturnType<typeof installationPlanningContext>,
  directories: readonly HarnessDirectoryInspection[],
  files: readonly Readonly<
    Pick<HarnessTargetInspection, "targetPath" | "exists" | "uid">
  >[],
): HarnessInstallationPlanner => {
  const { localElection, inventory, elections, effectiveUid } = context;
  const canonical =
    localElection !== undefined &&
    selectClaudeCanonicalLocalRootFromHeld(
      localElection.cwd,
      localElection.candidate,
      localElection.realHome,
      effectiveUid,
      { directories, files },
    ) === localElection.candidate;
  const selectedInventory = canonical ? localElection.inventory : inventory;
  if (input.harness === "claude-code" && selectedInventory === undefined)
    throw new Error("cli.harness.plugin-inventory-unavailable");
  return input.harness === "claude-code"
    ? createClaudeCodeInstallationPlanner(
        input.operation,
        context.invocation,
        selectedPluginInventory(
          selectedInventory!,
          canonical ? localElection.elections : elections,
          directories,
        ),
        input.dialectAuthority,
      )
    : context.codexPlanner!;
};

export const createProductHarnessInstallationInput = (
  input: ProductHarnessInstallationInput,
): HarnessInstallationPlanInput => {
  const context = installationPlanningContext(input);
  const { claude, launcher, settingsSelections, directoryPaths, guards } =
    context;
  const heldFiles = new Map<
    string,
    Readonly<Pick<HarnessTargetInspection, "targetPath" | "exists" | "uid">>
  >();
  let priorMetadata: PriorLauncherMetadata | undefined;
  const planner: HarnessInstallationPlanner = (target, directories = []) => {
    if (!claudeSettingsDirectoriesAgree(settingsSelections, directories))
      return Object.freeze({ kind: "conflict" as const });
    const guard = guards.find(
      (value) => value.targetPath === target.targetPath,
    );
    if (
      guard !== undefined &&
      (guard.exists !== target.exists ||
        guard.digest !== target.digest ||
        guard.mode !== target.mode)
    )
      return Object.freeze({ kind: "conflict" as const });
    heldFiles.set(
      target.targetPath,
      Object.freeze({
        targetPath: target.targetPath,
        exists: target.exists,
        ...(Object.hasOwn(target, "uid") ? { uid: target.uid } : {}),
      }),
    );
    if (target.targetPath === launcher.metadataPath) {
      const exact = ownedFileDecision(
        input.operation,
        target,
        launcher.metadataBytes,
        CONFIGURATION_MODE,
      );
      if (exact.kind !== "conflict") return exact;
      priorMetadata = priorLauncherMetadata(target.bytes, input, launcher);
      if (
        !priorMetadata ||
        target.mode !== CONFIGURATION_MODE ||
        !priorReleaseIsAdmissible(
          input.operation,
          priorMetadata.releaseIdentity,
          input.releaseIdentity,
        )
      )
        return Object.freeze({ kind: "conflict" as const });
      return input.operation === "uninstall"
        ? Object.freeze({ kind: "remove" as const })
        : Object.freeze({
            bytes: launcher.metadataBytes,
            kind: "replace" as const,
            mode: CONFIGURATION_MODE,
          });
    }
    if (target.targetPath === launcher.launcherPath) {
      const exact = ownedFileDecision(
        input.operation,
        target,
        launcher.launcherBytes,
        LAUNCHER_MODE,
      );
      if (exact.kind !== "conflict") return exact;
      if (
        !priorMetadata ||
        target.mode !== LAUNCHER_MODE ||
        target.bytes === null ||
        digest(target.bytes) !== priorMetadata.launcherSha256
      )
        return Object.freeze({ kind: "conflict" as const });
      return input.operation === "uninstall"
        ? Object.freeze({ kind: "remove" as const })
        : Object.freeze({
            bytes: launcher.launcherBytes,
            kind: "replace" as const,
            mode: LAUNCHER_MODE,
          });
    }
    if (target.targetPath === input.hookConfigurationPath) {
      const configurationPlanner = configurationPlannerFromHeld(
        input,
        context,
        directories,
        [...heldFiles.values()],
      );
      return configuredFileDecision(configurationPlanner, target);
    }
    if (guard !== undefined)
      return Object.freeze({ kind: "unchanged" as const });
    return Object.freeze({ kind: "unsupported" as const });
  };
  return Object.freeze({
    manifestPath: join(
      input.mutationDirectory,
      `harness-${claude ? "claude-code" : "codex"}-${input.operation}.json`,
    ),
    operation: input.operation,
    planner,
    ...(directoryPaths.length === 0 ? {} : { directoryPaths }),
    targetPaths: installationTargetPaths(
      launcher,
      input.hookConfigurationPath,
      guards,
    ),
  });
};
