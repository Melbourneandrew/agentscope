import { types } from "node:util";

export type HarnessTargetInspection = Readonly<{
  targetPath: string;
  exists: boolean;
  bytes: Uint8Array | null;
  digest: string;
  mode: number | null;
  uid?: number | null;
}>;

export type HarnessTargetDecision =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "replace"; bytes: Uint8Array; mode?: 0o600 | 0o700 }>
  | Readonly<{
      kind: "replace-overlap";
      bytes: Uint8Array;
      mode?: 0o600 | 0o700;
    }>
  | Readonly<{ kind: "remove" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "unsupported" }>;

export type HarnessInstallationPlanner = (
  target: HarnessTargetInspection,
  directories?: readonly HarnessDirectoryInspection[],
) => HarnessTargetDecision;

export type HarnessDirectoryInspection = Readonly<{
  directoryPath: string;
  exists: boolean;
  entries: readonly string[];
  mode: number | null;
  uid?: number | null;
}>;

export type HarnessInstallationPlanInput = Readonly<{
  manifestPath: string;
  operation: "install" | "migrate" | "uninstall";
  targetPaths: readonly string[];
  directoryPaths?: readonly string[];
  planner: HarnessInstallationPlanner;
}>;

const dataArray = (
  value: unknown,
  minimum: number,
): readonly unknown[] | undefined => {
  if (types.isProxy(value) || !Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // Array.isArray plus the Proxy refusal establish the intrinsic data length.
  const length = value.length;
  if (
    length < minimum ||
    length > 16 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  )
    return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return undefined;
    output.push(descriptor.value as unknown);
  }
  return Object.freeze(output);
};

type Namespace = Readonly<{
  canonical: (path: string) => Promise<string>;
  identity: (path: string) => string;
  canonicalSpelling: (path: string) => boolean;
  avoidsOwnership: (manifest: string, paths: readonly string[]) => boolean;
  invalid: () => never;
}>;

export const inspectInstallationInput = async (
  input: HarnessInstallationPlanInput,
  namespace: Namespace,
) => {
  const { invalid } = namespace;
  if (
    typeof input !== "object" ||
    input === null ||
    types.isProxy(input) ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors).sort().join("\0");
  if (
    (keys !== "manifestPath\0operation\0planner\0targetPaths" &&
      keys !==
        "directoryPaths\0manifestPath\0operation\0planner\0targetPaths") ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const manifest = descriptors.manifestPath?.value as unknown;
  const operation = descriptors.operation?.value as unknown;
  const planner = descriptors.planner?.value as unknown;
  const files = dataArray(descriptors.targetPaths?.value, 1);
  const directories = descriptors.directoryPaths
    ? dataArray(descriptors.directoryPaths.value, 0)
    : [];
  if (
    typeof manifest !== "string" ||
    !namespace.canonicalSpelling(manifest) ||
    typeof operation !== "string" ||
    !["install", "migrate", "uninstall"].includes(operation) ||
    typeof planner !== "function" ||
    !files ||
    !directories ||
    files.length + directories.length > 16
  )
    return invalid();
  const manifestPath = await namespace.canonical(manifest);
  const resolvePaths = async (values: readonly unknown[]) =>
    Promise.all(
      values.map(async (value) => {
        if (typeof value !== "string" || !namespace.canonicalSpelling(value))
          return invalid();
        return namespace.canonical(value);
      }),
    );
  const targetPaths = await resolvePaths(files);
  const directoryPaths = await resolvePaths(directories);
  const consulted = [...targetPaths, ...directoryPaths];
  const identities = consulted.map(namespace.identity);
  if (
    new Set(identities).size !== identities.length ||
    identities.includes(namespace.identity(manifestPath)) ||
    !namespace.avoidsOwnership(manifestPath, consulted)
  )
    return invalid();
  return Object.freeze({
    manifestPath,
    operation: operation as HarnessInstallationPlanInput["operation"],
    planner: planner as HarnessInstallationPlanner,
    targetPaths: Object.freeze(targetPaths),
    directoryPaths: Object.freeze(directoryPaths),
  });
};
