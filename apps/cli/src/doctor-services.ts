import {
  inspectAgentscopeDoctor,
  repairDoctorConfigurationTransaction,
  repairDoctorOperationalStateLock,
  type ConfigurationOwnerState,
  type ConfigurationProcessIdentity,
  type ConfigurationStore,
  type CredentialBackendRegistry,
  type CredentialResolutionContext,
  type DoctorFinding,
  type DoctorGitInspection,
  type DoctorReport,
  type OperationalStateStore,
} from "@agentscope/core";
import {
  isDestinationReachabilityProbe,
  type DestinationReachabilityProbe,
} from "@agentscope/destinations-core";

import type { CliOperationResult } from "./cli-contract.js";
import type {
  CliDoctorEvidence,
  CliDoctorFinding,
  CliDoctorRepair,
  CliDoctorReport,
  CliDoctorServices,
} from "./doctor-commands.js";
import type {
  CliHarnessDiscovery,
  CliHarnessServices,
  CliHarnessStatusValue,
} from "./harness-commands.js";

const MAXIMUM_REACHABILITY_PROBES = 32;
const REACHABILITY_TIMEOUT_MILLISECONDS = 1_000;

export type CreateDoctorCliServicesInput = Readonly<{
  configurationStore: ConfigurationStore;
  credentialRegistry: CredentialBackendRegistry;
  credentialResolutionContext: CredentialResolutionContext;
  gitInspector: () => Promise<DoctorGitInspection>;
  harnessServices: CliHarnessServices;
  operationalStateStore: OperationalStateStore;
  ownerState: (owner: ConfigurationProcessIdentity) => ConfigurationOwnerState;
  reachabilityProbes?: readonly DestinationReachabilityProbe[];
}>;

const success = <Value>(value: Value): CliOperationResult<Value> =>
  Object.freeze({ status: "success" as const, value });

const evidence = (input: CliDoctorEvidence): CliDoctorEvidence =>
  Object.freeze(input);

const finding = (
  code: CliDoctorFinding["code"],
  severity: CliDoctorFinding["severity"],
  suggestedAction: CliDoctorFinding["suggestedAction"],
  findingEvidence: CliDoctorEvidence,
): CliDoctorFinding =>
  Object.freeze({
    code,
    evidence: findingEvidence,
    severity,
    suggestedAction,
  });

const scopeForCoreFinding = (
  code: DoctorFinding["code"],
): CliDoctorEvidence["scope"] => {
  if (code.startsWith("doctor.configuration.")) return "configuration";
  if (code.startsWith("doctor.transaction.")) return "transaction";
  if (code.startsWith("doctor.credential-mutation."))
    return "credential-mutation";
  if (code.startsWith("doctor.credential.")) return "credential";
  return "operational-state";
};

const stateForCode = (
  code: DoctorFinding["code"],
): CliDoctorEvidence["state"] => {
  const separator = code.lastIndexOf(".");
  return code.slice(separator + 1) as CliDoctorEvidence["state"];
};

const mapCoreFindings = (report: DoctorReport): CliDoctorFinding[] => {
  let credentialIndex = 0;
  return report.findings.map((entry) => {
    const credential = entry.code.startsWith("doctor.credential.")
      ? report.credentials[credentialIndex++]
      : undefined;
    return finding(
      entry.code,
      entry.severity,
      entry.suggestedAction,
      evidence({
        count: null,
        freshness: "current",
        lossCount: null,
        scope: scopeForCoreFinding(entry.code),
        state: stateForCode(entry.code),
        subject: credential?.connectionId ?? null,
        version: null,
      }),
    );
  });
};

const pipelineFinding = (report: DoctorReport): CliDoctorFinding => {
  if (report.operationalState.state !== "available")
    return finding(
      "doctor.pipeline-health.unavailable",
      "warning",
      "retry",
      evidence({
        count: null,
        freshness: "unavailable",
        lossCount: null,
        scope: "pipeline-health",
        state: "unavailable",
        subject: null,
        version: null,
      }),
    );
  const snapshot = report.operationalState.snapshot;
  return finding(
    snapshot.health.length === 0
      ? "doctor.pipeline-health.absent"
      : "doctor.pipeline-health.retained",
    snapshot.health.length === 0 ? "warning" : "info",
    "none",
    evidence({
      count: snapshot.health.length,
      freshness: "retained",
      lossCount: snapshot.losses.health,
      scope: "pipeline-health",
      state: snapshot.health.length === 0 ? "absent" : "retained",
      subject: null,
      version: null,
    }),
  );
};

const harnessDiscoveryFinding = (
  value: CliHarnessDiscovery,
): CliDoctorFinding => {
  const state = value.state;
  const severity =
    state === "installed" ? "info" : state === "absent" ? "warning" : "error";
  const action =
    state === "absent"
      ? "install-harness"
      : state === "installed"
        ? "none"
        : "retry";
  return finding(
    `doctor.harness.${state}`,
    severity,
    action,
    evidence({
      count: value.configurationPresentCount,
      freshness: "current",
      lossCount: null,
      scope: "harness",
      state,
      subject: value.harness,
      version: value.version,
    }),
  );
};

const hookFinding = (
  harness: string,
  disposition: CliHarnessStatusValue["installation"] | "unavailable",
): CliDoctorFinding => {
  const valid = disposition === "unchanged";
  const severity = valid
    ? "info"
    : disposition === "ready"
      ? "warning"
      : "error";
  const action =
    disposition === "ready"
      ? "install-harness"
      : disposition === "conflict"
        ? "migrate-harness"
        : valid
          ? "none"
          : "retry";
  return finding(
    `doctor.hook.${disposition}`,
    severity,
    action,
    evidence({
      count: null,
      freshness: "current",
      lossCount: null,
      scope: "hook",
      state: disposition,
      subject: harness,
      version: null,
    }),
  );
};

const inspectHarnesses = async (
  services: CliHarnessServices,
): Promise<readonly CliDoctorFinding[]> => {
  const listed = await services.listHarnesses();
  if (listed.status !== "success")
    return Object.freeze([
      finding(
        "doctor.harness.unavailable",
        "warning",
        "retry",
        evidence({
          count: null,
          freshness: "unavailable",
          lossCount: null,
          scope: "harness",
          state: "unavailable",
          subject: null,
          version: null,
        }),
      ),
    ]);
  const findings: CliDoctorFinding[] = [];
  for (const harness of listed.value.harnesses) {
    findings.push(harnessDiscoveryFinding(harness));
    const status = await services.statusHarness({ harness: harness.harness });
    findings.push(
      status.status === "success"
        ? hookFinding(harness.harness, status.value.installation)
        : hookFinding(harness.harness, "unavailable"),
    );
  }
  return Object.freeze(findings);
};

const snapshotReachabilityProbes = (
  input: readonly DestinationReachabilityProbe[] | undefined,
): ReadonlyMap<string, DestinationReachabilityProbe["inspect"]> => {
  const probes = input === undefined ? [] : input;
  if (
    !Array.isArray(probes) ||
    Object.getPrototypeOf(probes) !== Array.prototype ||
    probes.length > MAXIMUM_REACHABILITY_PROBES ||
    Reflect.ownKeys(Object.getOwnPropertyDescriptors(probes)).length !==
      probes.length + 1
  )
    throw new Error("cli.doctor.invalid");
  const output = new Map<string, DestinationReachabilityProbe["inspect"]>();
  for (let index = 0; index < probes.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(probes, String(index));
    const value: unknown =
      descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (
      !isDestinationReachabilityProbe(value) ||
      output.has(value.destinationType)
    )
      throw new Error("cli.doctor.invalid");
    output.set(value.destinationType, value.inspect);
  }
  return output;
};

const inspectOneDestination = async (
  connection: DoctorReport["connections"][number],
  probe: DestinationReachabilityProbe["inspect"] | undefined,
): Promise<CliDoctorFinding> => {
  if (!probe)
    return finding(
      "doctor.destination.probe-unsupported",
      "info",
      "none",
      evidence({
        count: null,
        freshness: "current",
        lossCount: null,
        scope: "destination",
        state: "probe-unsupported",
        subject: connection.connectionId,
        version: null,
      }),
    );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"unavailable">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unavailable");
    }, REACHABILITY_TIMEOUT_MILLISECONDS);
  });
  let operation: Promise<"available" | "unavailable">;
  try {
    operation = Promise.resolve(
      probe({
        connectionId: connection.connectionId,
        signal: controller.signal,
      }),
    ).then((value) => (value === "available" ? value : "unavailable"));
  } catch {
    operation = Promise.resolve("unavailable");
  }
  operation.catch(() => undefined);
  const state = await Promise.race([
    operation.catch(() => "unavailable" as const),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return finding(
    `doctor.destination.${state}`,
    state === "available" ? "info" : "warning",
    state === "available" ? "none" : "inspect-destination",
    evidence({
      count: null,
      freshness: "current",
      lossCount: null,
      scope: "destination",
      state,
      subject: connection.connectionId,
      version: null,
    }),
  );
};

const inspectDestinations = (
  report: DoctorReport,
  probes: ReadonlyMap<string, DestinationReachabilityProbe["inspect"]>,
): Promise<readonly CliDoctorFinding[]> =>
  Promise.all(
    report.connections.map((connection) =>
      inspectOneDestination(connection, probes.get(connection.destinationType)),
    ),
  );

const gitFinding = (value: DoctorGitInspection): CliDoctorFinding => {
  const state =
    value.workspace === "unavailable"
      ? "workspace-unavailable"
      : value.repository === "unavailable"
        ? "repository-unavailable"
        : value.head === "detached"
          ? "detached"
          : "available";
  return finding(
    `doctor.git.${state}`,
    state === "available" || state === "detached" ? "info" : "warning",
    state === "available" || state === "detached" ? "none" : "retry",
    evidence({
      count: null,
      freshness: "current",
      lossCount: null,
      scope: "git",
      state,
      subject: null,
      version: null,
    }),
  );
};

const summarize = (
  findings: readonly CliDoctorFinding[],
): CliDoctorReport["summary"] =>
  Object.freeze({
    errors: findings.filter(({ severity }) => severity === "error").length,
    information: findings.filter(({ severity }) => severity === "info").length,
    warnings: findings.filter(({ severity }) => severity === "warning").length,
  });

const compileReport = (
  findings: readonly CliDoctorFinding[],
  repairs: readonly CliDoctorRepair[],
  fixed: boolean,
): CliDoctorReport =>
  Object.freeze({
    findings: Object.freeze([...findings]),
    fixed,
    repairs: Object.freeze([...repairs]),
    summary: summarize(findings),
  });

const inspectAll = async (
  input: CreateDoctorCliServicesInput,
  probes: ReadonlyMap<string, DestinationReachabilityProbe["inspect"]>,
): Promise<readonly CliDoctorFinding[]> => {
  const core = await inspectAgentscopeDoctor({
    configurationStore: input.configurationStore,
    credentialRegistry: input.credentialRegistry,
    credentialResolutionContext: input.credentialResolutionContext,
    operationalStateStore: input.operationalStateStore,
    ownerState: input.ownerState,
  });
  const [harnesses, destinations, git] = await Promise.all([
    inspectHarnesses(input.harnessServices),
    inspectDestinations(core, probes),
    input.gitInspector().catch(() =>
      Object.freeze({
        head: "unavailable" as const,
        repository: "unavailable" as const,
        workspace: "unavailable" as const,
      }),
    ),
  ]);
  return Object.freeze([
    ...mapCoreFindings(core),
    pipelineFinding(core),
    ...harnesses,
    ...destinations,
    gitFinding(git),
  ]);
};

const repairActions = (
  findings: readonly CliDoctorFinding[],
): readonly CliDoctorRepair["action"][] =>
  Object.freeze(
    [
      "repair-configuration-transaction",
      "repair-operational-state-lock",
    ].filter((action): action is CliDoctorRepair["action"] =>
      findings.some(({ suggestedAction }) => suggestedAction === action),
    ),
  );

const applyRepair = async (
  input: CreateDoctorCliServicesInput,
  action: CliDoctorRepair["action"],
): Promise<CliDoctorRepair> => {
  try {
    if (action === "repair-configuration-transaction")
      await repairDoctorConfigurationTransaction(
        input.configurationStore,
        input.ownerState,
      );
    else
      await repairDoctorOperationalStateLock(
        input.operationalStateStore,
        input.ownerState,
      );
    return Object.freeze({ action, state: "applied" });
  } catch {
    return Object.freeze({ action, state: "unavailable" });
  }
};

export const createDoctorCliServices = (
  input: CreateDoctorCliServicesInput,
): CliDoctorServices => {
  const probes = snapshotReachabilityProbes(input.reachabilityProbes);
  return Object.freeze({
    doctor: async ({ fix, presentPlan }) => {
      const initial = await inspectAll(input, probes);
      const actions = repairActions(initial);
      if (!fix || actions.length === 0)
        return success(compileReport(initial, [], false));
      const planned = actions.map((action) =>
        Object.freeze({ action, state: "planned" as const }),
      );
      await presentPlan(compileReport(initial, planned, false));
      const repairs = await Promise.all(
        actions.map((action) => applyRepair(input, action)),
      );
      const final = await inspectAll(input, probes);
      return success(
        compileReport(
          final,
          repairs,
          repairs.some(({ state }) => state === "applied"),
        ),
      );
    },
  });
};
