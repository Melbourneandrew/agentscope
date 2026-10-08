import type {
  HarnessDirectoryInspection,
  HarnessInstallationPlanner,
  HarnessTargetInspection,
  OwnedHarnessHookInvocation,
} from "@agentscope/harnesses-core";
import {
  createClaudeCodeInstallationPlanner,
  type ClaudeCodeDialectAuthority,
  type ClaudeCodePluginInventory,
} from "../lifecycle.js";
import {
  createClaudeDiscoveryProbe,
  captureClaudeEnvironment,
  claudeUserConfiguration,
} from "./claude-discovery.js";
import {
  readClaudePluginContextObservation,
  discoverClaudeCanonicalSettingsRoot,
  mergeClaudePluginReadGuards,
} from "./claude-plugin-context.js";
import {
  claudeSettingsDirectoriesAgree,
  claudeDirectoryDependencies,
  selectClaudeCanonicalLocalRootFromHeld,
  mergeClaudeSettingsDirectorySelections,
  type ClaudeSettingsDirectorySelection,
} from "./claude-managed-settings.js";
import {
  selectClaudePluginCacheRecord,
  selectClaudePluginLoadingPath,
  type ClaudePluginCacheElection,
} from "./claude-plugin-inventory.js";
import {
  snapshotClaudePlugin as snapshotPlugin,
  snapshotClaudePluginInventory as snapshotInventory,
} from "./claude-plugin-selection.js";
import type {
  ClaudeCodeDiscoveryReadCapabilities,
  ProductHarnessReadGuard,
} from "./capabilities.js";
export type ClaudeCodeInstallationContext = Readonly<{
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
}>;
type ContextInput = Readonly<{
  homeDirectory: string;
  projectDirectory: string;
  platform: NodeJS.Platform;
  environment: Readonly<Record<string, string | undefined>>;
}>;

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

const observeInstallationContext = async (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
  input: ContextInput,
) => {
  const environment = captureClaudeEnvironment(input.environment);
  const realHome = await capabilities
    .realpath(input.homeDirectory)
    .catch(() => null);
  const routes = await discoverClaudeCanonicalSettingsRoot(
    capabilities,
    input.projectDirectory,
    realHome,
  );
  const plugins = await readClaudePluginContextObservation(capabilities, {
    ...input,
    environment,
  });
  const canonical =
    routes.candidate !== null &&
    routes.candidate !== input.projectDirectory &&
    realHome !== null &&
    routes.candidate !== realHome
      ? await readClaudePluginContextObservation(capabilities, {
          ...input,
          environment,
          localSettingsRoot: routes.candidate,
        })
      : undefined;
  return Object.freeze({
    ...plugins,
    readGuards: mergeClaudePluginReadGuards([
      plugins.readGuards,
      routes.readGuards,
      canonical?.readGuards ?? [],
    ]),
    settingsDirectorySelections: mergeClaudeSettingsDirectorySelections([
      plugins.settingsDirectorySelections,
      routes.settingsDirectorySelections,
      canonical?.settingsDirectorySelections ?? [],
    ]),
    ...(canonical === undefined
      ? {}
      : {
          localSettingsElection: Object.freeze({
            cwd: input.projectDirectory,
            candidate: routes.candidate!,
            realHome,
            canonical,
          }),
        }),
  });
};

export const prepareClaudeCodeInstallationContext = (
  input: ClaudeCodeInstallationContext,
  effectiveUid: number | null,
) => {
  const inventory =
    input.pluginInventory === null
      ? undefined
      : snapshotInventory(input.pluginInventory);
  const elections = snapshotElections(input.cacheElections);
  const source = input.localSettingsElection;
  const localElection =
    source === undefined
      ? undefined
      : Object.freeze({
          cwd: source.cwd,
          candidate: source.candidate,
          realHome: source.realHome,
          inventory:
            source.canonical.pluginInventory === null
              ? undefined
              : snapshotInventory(source.canonical.pluginInventory),
          elections: snapshotElections(source.canonical.cacheElections),
        });
  const { settingsSelections, directoryPaths } = claudeDirectoryDependencies(
    input.settingsDirectorySelections,
    [
      ...electionDirectoryPaths(elections),
      ...electionDirectoryPaths(localElection?.elections),
    ],
  );
  return Object.freeze({
    directoryPaths,
    settingsDirectoriesAgree: (
      directories: readonly HarnessDirectoryInspection[],
    ) => claudeSettingsDirectoriesAgree(settingsSelections, directories),
    configurationPlanner: (
      operation: "install" | "migrate" | "uninstall",
      invocation: OwnedHarnessHookInvocation,
      dialectAuthority: ClaudeCodeDialectAuthority,
      directories: readonly HarnessDirectoryInspection[],
      files: readonly Pick<
        HarnessTargetInspection,
        "targetPath" | "exists" | "uid"
      >[],
    ): HarnessInstallationPlanner => {
      const canonical =
        localElection !== undefined &&
        selectClaudeCanonicalLocalRootFromHeld(
          localElection.cwd,
          localElection.candidate,
          localElection.realHome,
          effectiveUid,
          { directories, files },
        ) === localElection.candidate;
      const selected = canonical ? localElection.inventory : inventory;
      if (selected === undefined)
        throw new Error("cli.harness.plugin-inventory-unavailable");
      return createClaudeCodeInstallationPlanner(
        operation,
        invocation,
        selectedPluginInventory(
          selected,
          canonical ? localElection.elections : elections,
          directories,
        ),
        dialectAuthority,
      );
    },
  });
};

// Complete first-party semantic factory. The application owns its readers and
// its original Core transaction; neither this object nor its DTOs mint authority.
export const createClaudeCodeDiscoveryContextFactory = (
  capabilities: ClaudeCodeDiscoveryReadCapabilities,
) => {
  const readers = Object.freeze({ ...capabilities });
  return Object.freeze({
    bindInvocation: (
      input: Parameters<typeof createClaudeDiscoveryProbe>[0] &
        Readonly<{ projectDirectory: string }>,
    ) => {
      const invocation = Object.freeze({
        ...input,
        environment: captureClaudeEnvironment(input.environment),
      });
      return Object.freeze({
        probe: createClaudeDiscoveryProbe(invocation, readers),
        configurationPath: () =>
          invocation.homeDirectory === undefined
            ? undefined
            : claudeUserConfiguration(
                invocation.homeDirectory,
                invocation.projectDirectory,
                invocation.environment,
              ).settingsPath,
        observeInstallationContext: () => {
          if (invocation.homeDirectory === undefined)
            throw new Error("cli.harness.plugin-inventory-unavailable");
          return observeInstallationContext(readers, {
            ...invocation,
            homeDirectory: invocation.homeDirectory,
          });
        },
      });
    },
  });
};
