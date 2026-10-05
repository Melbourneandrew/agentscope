import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { SUBSTRATE_CERTIFICATION_PREDICATES } from "./substrate-certification.js";
import type { IntegrationControllerMode } from "./controller-stages.js";

const supplied = (
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      names.map((name) => {
        const value = environment[name];
        if (value === undefined || value.length < 1 || value.length > 1024)
          throw new Error("integration.controller.disposable-host-identity");
        return [name, value];
      }),
    ),
  );

/** Host classification only; the existing controller remains the capability owner. */
export const inferModeAndIdentity = (
  environment: NodeJS.ProcessEnv,
): {
  identity: Readonly<Record<string, string>>;
  mode: IntegrationControllerMode;
  hostKind: "crabbox" | "github-hosted";
} => {
  if (environment.AGENTSCOPE_INTEGRATION_EXECUTOR === "crabbox") {
    const identity = supplied(environment, [
      "CRABBOX_LEASE_ID",
      "CRABBOX_RUN_ID",
      "CRABBOX_SLUG",
    ]);
    if (
      !/^cbx_[A-Za-z0-9_-]+$/u.test(identity.CRABBOX_LEASE_ID!) ||
      !/^run_[A-Za-z0-9_-]+$/u.test(identity.CRABBOX_RUN_ID!) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(identity.CRABBOX_SLUG!)
    )
      throw new Error("integration.controller.disposable-host-identity");
    return { hostKind: "crabbox", identity, mode: "crabbox" };
  }
  if (
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted"
  ) {
    const identity = supplied(environment, [
      "GITHUB_JOB",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "RUNNER_NAME",
      "AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS",
    ]);
    if (
      !/^\d+$/u.test(identity.GITHUB_RUN_ID!) ||
      !/^\d+$/u.test(identity.GITHUB_RUN_ATTEMPT!) ||
      !/^[a-f0-9]{40}$/u.test(identity.GITHUB_SHA!)
    )
      throw new Error("integration.controller.disposable-host-identity");
    return {
      hostKind: "github-hosted",
      identity,
      mode:
        environment.AGENTSCOPE_INTEGRATION_MODE === "candidate"
          ? "candidate"
          : "lifecycle",
    };
  }
  throw new Error("integration.controller.disposable-host-required");
};
export const git = (
  workspaceRoot: string,
  arguments_: readonly string[],
  maximumMilliseconds = 30_000,
): string => {
  if (
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    maximumMilliseconds > 30_000
  )
    throw new Error("integration.controller.deadline");
  return execFileSync("/usr/bin/git", [...arguments_], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    timeout: maximumMilliseconds,
  }).trim();
};

export const hasCredentialGitState = (workspaceRoot: string): boolean => {
  const entries = git(workspaceRoot, ["config", "--local", "--null", "--list"])
    .split("\0")
    .filter(Boolean);
  return entries.some((entry) => {
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    return (
      /^(?:credential\.|http\.|include\.|includeif\.|url\.)/u.test(key) ||
      key === "core.sshcommand" ||
      /:\/\/[^/@\s]+@/u.test(value)
    );
  });
};

export const publishCredentialPreflightFailure = (
  environment: NodeJS.ProcessEnv,
  error: unknown,
): void => {
  if (
    !(error instanceof Error) ||
    error.message !== "integration.controller.provider-credentials" ||
    environment.AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE !==
      "credential-presence" ||
    typeof environment.GITHUB_SHA !== "string" ||
    !/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA)
  )
    return;
  const record = Object.freeze({
    certificationCase: "credential-presence",
    certificationPredicate:
      SUBSTRATE_CERTIFICATION_PREDICATES["credential-presence"],
    controllerPreflightFailureVersion: 1,
    githubSha: environment.GITHUB_SHA,
    mutationAuthority: "not-created",
    primaryFailure: error.message,
  });
  const serialized = `${JSON.stringify(record, undefined, 2)}\n`;
  const directory = resolve(
    import.meta.dirname,
    "../../../artifacts/integration",
  );
  const target = resolve(directory, "controller-preflight-failure.json");
  const temporary = resolve(
    directory,
    `.controller-preflight-failure.${process.pid}.tmp`,
  );
  let descriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    const directoryStatus = lstatSync(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink())
      throw new Error("integration.certification.preflight-evidence");
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
    rmSync(temporary);
    directoryDescriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    const status = lstatSync(target);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size !== Buffer.byteLength(serialized, "utf8") ||
      (status.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.certification.preflight-evidence");
  } catch (publicationError) {
    rmSync(temporary, { force: true });
    throw new Error("integration.certification.preflight-evidence", {
      cause: publicationError,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
};
