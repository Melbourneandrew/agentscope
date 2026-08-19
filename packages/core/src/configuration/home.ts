import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir as nodeHomedir } from "node:os";
import { posix, win32 } from "node:path";

export const AGENTSCOPE_HOME_ENVIRONMENT_VARIABLE = "AGENTSCOPE_HOME";
export const AGENTSCOPE_HOME_DIRECTORY_NAME = ".agentscope";

const DIRECTORY_MODE = 0o700;
const MAXIMUM_PATH_LENGTH = 4_096;
const resolvedHomes = new WeakSet<object>();

export type AgentscopeHome = Readonly<{
  root: string;
  configFile: string;
  configBackupFile: string;
  mutationDirectory: string;
  destinationDirectory: string;
  diagnosticDirectory: string;
  healthDirectory: string;
  checkpointDirectory: string;
  platform: NodeJS.Platform;
}>;

export type AgentscopeHomeResolver = () => AgentscopeHome;

export type AgentscopeHomeResolverInput = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  homedir?: () => string;
  environmentOverrideAuthority?: "ci" | "portable" | "test";
  platform?: NodeJS.Platform;
}>;

export class AgentscopeHomeError extends Error {
  public readonly code = "core.configuration.home.invalid";

  public constructor() {
    super("core.configuration.home.invalid");
    this.name = "AgentscopeHomeError";
  }
}

const invalid = (): never => {
  throw new AgentscopeHomeError();
};

const pathApiFor = (platform: NodeJS.Platform): typeof posix =>
  platform === "win32" ? win32 : posix;

const safePath = (candidate: unknown, pathApi: typeof posix): string => {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.trim().length === 0 ||
    candidate.length > MAXIMUM_PATH_LENGTH ||
    candidate.includes("\0") ||
    !pathApi.isAbsolute(candidate)
  )
    return invalid();
  const normalized = pathApi.normalize(candidate);
  if (normalized === pathApi.parse(normalized).root) return invalid();
  return normalized;
};

const resolveRoot = (input: AgentscopeHomeResolverInput): AgentscopeHome => {
  try {
    const platform = input.platform ?? process.platform;
    const pathApi = pathApiFor(platform);
    const environment = input.environment ?? process.env;
    const override =
      input.environmentOverrideAuthority === undefined
        ? undefined
        : environment[AGENTSCOPE_HOME_ENVIRONMENT_VARIABLE];
    const root =
      override === undefined
        ? safePath(
            pathApi.join(
              (input.homedir ?? nodeHomedir)(),
              AGENTSCOPE_HOME_DIRECTORY_NAME,
            ),
            pathApi,
          )
        : safePath(override, pathApi);
    const home = Object.freeze({
      root,
      configFile: pathApi.join(root, "config.json"),
      configBackupFile: pathApi.join(root, "config.last-known-good.json"),
      mutationDirectory: pathApi.join(root, "mutations"),
      destinationDirectory: pathApi.join(root, "destinations"),
      diagnosticDirectory: pathApi.join(root, "diagnostics"),
      healthDirectory: pathApi.join(root, "health"),
      checkpointDirectory: pathApi.join(root, "checkpoints"),
      platform,
    });
    resolvedHomes.add(home);
    return home;
  } catch {
    return invalid();
  }
};

export const createAgentscopeHomeResolver = (
  input: AgentscopeHomeResolverInput = {},
): AgentscopeHomeResolver => {
  const resolved = resolveRoot(input);
  return () => resolved;
};

export const createAgentscopeHomeFromOwnedRootForCore = (
  root: string,
  platform: NodeJS.Platform,
): AgentscopeHome =>
  resolveRoot({
    environment: { [AGENTSCOPE_HOME_ENVIRONMENT_VARIABLE]: root },
    environmentOverrideAuthority: "portable",
    platform,
  });

export const isAgentscopeHome = (value: unknown): value is AgentscopeHome =>
  typeof value === "object" && value !== null && resolvedHomes.has(value);

const ensureDirectory = async (
  directory: string,
  enforcePosixPermissions: boolean,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) return invalid();
  /* v8 ignore next -- Windows intentionally has no POSIX chmod; native ACL evidence belongs to Phase 11 trusted CI. */
  if (enforcePosixPermissions) await chmod(directory, DIRECTORY_MODE);
};

export const ensureAgentscopeHomeLayout = async (
  home: AgentscopeHome,
): Promise<AgentscopeHome> => {
  try {
    if (!resolvedHomes.has(home)) return invalid();
    const directories = [
      home.root,
      home.mutationDirectory,
      home.destinationDirectory,
      home.diagnosticDirectory,
      home.healthDirectory,
      home.checkpointDirectory,
    ];
    for (const directory of directories)
      await ensureDirectory(directory, home.platform !== "win32");
    return home;
  } catch {
    return invalid();
  }
};
