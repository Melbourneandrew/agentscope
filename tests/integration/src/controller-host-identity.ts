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
