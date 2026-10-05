import { types } from "node:util";
import type { IntegrationControllerMode } from "./controller-stages.js";

/** A terminal filter, not an execution authority or a receipt verifier. */
export const mockServerResearchStopFitsTerminalObservation = (
  input: unknown,
): boolean => {
  try {
    if (input === null || typeof input !== "object" || types.isProxy(input))
      return false;
    const expected = {
      code: 3,
      signal: null,
      contained: true,
      residualWorkObserved: false,
      terminationInitiated: false,
      completedWithinDeadline: true,
    };
    return Object.entries(expected).every(([name, value]) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.value === value
      );
    });
  } catch {
    return false;
  }
};

export type MockServerResearchRequest = Readonly<
  | { kind: "none" }
  | {
      kind: "supplier";
      repository: string;
      revision: string;
      runId: string;
      attempt: string;
      workflowRef: string;
      workflowRevision: string;
    }
>;

const fail = (): never => {
  throw new Error("integration.mockserver-material.research-request");
};
const own = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) fail();
  const value: unknown = descriptor.value;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1024) return fail();
  return value;
};
const conflicts = [
  "AGENTSCOPE_INTEGRATION_SCENARIO",
  "AGENTSCOPE_INTEGRATION_SHARD",
  "AGENTSCOPE_INTEGRATION_FULL",
  "AGENTSCOPE_INTEGRATION_HARNESS",
  "AGENTSCOPE_INTEGRATION_TAG",
  "AGENTSCOPE_INTEGRATION_TEST_MODE",
  "AGENTSCOPE_SUBSTRATE_CERTIFICATION_REPLAY",
  "AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE",
];

/** A closed request is data; only the existing disposable-host controller executes it. */
export const parseMockServerResearchRequest = (
  environment: NodeJS.ProcessEnv,
  hostKind: "crabbox" | "github-hosted",
  mode: IntegrationControllerMode,
): MockServerResearchRequest => {
  try {
    if (types.isProxy(environment)) fail();
    const request = own(environment, "AGENTSCOPE_MOCKSERVER_RESEARCH");
    if (request === undefined) return Object.freeze({ kind: "none" });
    if (
      request !== "supplier" ||
      hostKind !== "github-hosted" ||
      mode !== "lifecycle" ||
      own(environment, "GITHUB_ACTIONS") !== "true" ||
      own(environment, "RUNNER_ENVIRONMENT") !== "github-hosted" ||
      own(environment, "GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
      own(environment, "GITHUB_JOB") !== "mockserver-supplier-research" ||
      conflicts.some((name) => own(environment, name) !== undefined)
    )
      return fail();
    const repository = own(environment, "GITHUB_REPOSITORY");
    const revision = own(environment, "GITHUB_SHA");
    const workflowRevision = own(environment, "GITHUB_WORKFLOW_SHA");
    const workflowRef = own(environment, "GITHUB_WORKFLOW_REF");
    const runId = own(environment, "GITHUB_RUN_ID");
    const attempt = own(environment, "GITHUB_RUN_ATTEMPT");
    if (
      repository === undefined ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository) ||
      revision === undefined ||
      !/^[a-f0-9]{40}$/u.test(revision) ||
      workflowRevision !== revision ||
      workflowRef === undefined ||
      !workflowRef.startsWith(
        `${repository}/.github/workflows/integration.yml@refs/heads/`,
      ) ||
      !/^[A-Za-z0-9_./@-]{1,512}$/u.test(workflowRef) ||
      workflowRef.endsWith("/") ||
      workflowRef.includes("..") ||
      runId === undefined ||
      !/^[1-9]\d{0,19}$/u.test(runId) ||
      attempt === undefined ||
      !/^[1-9]\d{0,5}$/u.test(attempt)
    )
      return fail();
    return Object.freeze({
      kind: "supplier",
      repository,
      revision,
      runId,
      attempt,
      workflowRef,
      workflowRevision,
    });
  } catch {
    return fail();
  }
};
