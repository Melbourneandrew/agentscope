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
} from "@agentscope/harnesses-core";
import {
  codexHarnessDescriptor,
  createCodexInstallationPlanner,
} from "@agentscope/harness-codex";

import { createOwnedHookLauncherArtifacts } from "./hook-launcher.js";

const CONFIGURATION_MODE = 0o600;
const LAUNCHER_MODE = 0o700;
const releaseIdentityPattern = /^[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export type ProductHarnessInstallationInput = Readonly<{
  agentscopeHome: string;
  hookConfigurationPath: string;
  hookDeadlineMilliseconds: number;
  machineEntryPath: string;
  mutationDirectory: string;
  nodeExecutable: string;
  operation: "install" | "migrate" | "uninstall";
  releaseIdentity: string;
}>;

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
      harnessType: codexHarnessDescriptor.harnessType,
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

export const createProductHarnessInstallationInput = (
  input: ProductHarnessInstallationInput,
): HarnessInstallationPlanInput => {
  const invocation = createOwnedHarnessHookInvocation({
    agentscopeHome: input.agentscopeHome,
    harnessType: codexHarnessDescriptor.harnessType,
    hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
    platform: "posix",
  });
  const launcher = createOwnedHookLauncherArtifacts({
    agentscopeHome: input.agentscopeHome,
    harnessType: codexHarnessDescriptor.harnessType,
    hookDeadlineMilliseconds: input.hookDeadlineMilliseconds,
    machineEntryPath: input.machineEntryPath,
    nodeExecutable: input.nodeExecutable,
    platform: "posix",
    releaseIdentity: input.releaseIdentity,
  });
  const codexPlanner = createCodexInstallationPlanner(
    input.operation,
    invocation,
  );
  let priorMetadata: PriorLauncherMetadata | undefined;
  const planner: HarnessInstallationPlanner = (target) => {
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
    if (target.targetPath === input.hookConfigurationPath)
      return configuredFileDecision(codexPlanner, target);
    return Object.freeze({ kind: "unsupported" as const });
  };
  return Object.freeze({
    manifestPath: join(
      input.mutationDirectory,
      `harness-codex-${input.operation}.json`,
    ),
    operation: input.operation,
    planner,
    targetPaths: Object.freeze([
      launcher.metadataPath,
      launcher.launcherPath,
      input.hookConfigurationPath,
    ]),
  });
};
