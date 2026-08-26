import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
  type HarnessInstallationPlanner,
} from "./installation.js";
import {
  createOwnedHarnessHookInvocation,
  type OwnedHarnessHookInvocation,
} from "./launcher.js";
import type {
  NativeCaptureBoundary,
  NativeCheckpointRequest,
  NativeCheckpointResolver,
  NativeFieldProvenance,
  NativeUnavailableField,
} from "./native-mapping.js";
import {
  parseHarnessSanitizedFixture,
  type HarnessSanitizedFixture,
} from "./native-fixture-governance.js";
import { parseStableSemver, stableSemverIsInRange } from "./semver.js";
import type { HarnessDescriptor } from "./types.js";

export type HarnessContractCase = Readonly<{
  name: string;
  run: () => Promise<void>;
}>;

export class HarnessContractAssertionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "HarnessContractAssertionError";
  }
}

const assert = (condition: boolean, code: string): void => {
  if (!condition) throw new HarnessContractAssertionError(code);
};

export type HarnessFixtureMapping = Readonly<{
  boundary: NativeCaptureBoundary;
  provenance: readonly NativeFieldProvenance[];
  unavailable: readonly NativeUnavailableField[];
}>;

export type HarnessScenarioAdapter = Readonly<{
  scenarioVersion: 1;
  scenarioId: string;
  harnessId: string;
  harnessPackage: string;
  representativeVersion: string;
  fixtureId: string;
  tags: readonly string[];
  commandArguments: readonly string[];
}>;

export type HarnessHookTestBehavior = "success" | "failure" | "hang";

export type HarnessContractContextEvidence = Readonly<{
  evidenceVersion: 1;
  mappingArtifactDigest: string;
  contextDigest: string;
}>;

export type HarnessComponentEvidence = Readonly<{
  evidenceVersion: 1;
  harnessType: string;
  testedVersion: string;
  fixtureId: string;
  scenarioId: string;
  evidenceSlot: string;
  componentDigest: `component-sha256-${string}`;
}>;

export type HarnessComponentContractAdapter = Readonly<{
  descriptor: HarnessDescriptor;
  componentEvidence: HarnessComponentEvidence;
  compatibleVersion: string;
  fixture: HarnessSanitizedFixture;
  scenario: HarnessScenarioAdapter;
  contextEvidence: HarnessContractContextEvidence;
  mapFixture: (resolver: NativeCheckpointResolver) => HarnessFixtureMapping;
  createInstallationPlanner: (
    operation: "install" | "migrate" | "uninstall",
    invocation: OwnedHarnessHookInvocation,
  ) => HarnessInstallationPlanner;
  runHook: (
    behavior: HarnessHookTestBehavior,
    signal: AbortSignal,
  ) => Promise<"completed" | "failed-open">;
}>;

const digestPattern = /^sha256-[a-f0-9]{64}$/u;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const packagePattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const shellSyntax = /(?:[;&|`$<>\n\r]|\$\(|\{\{)/u;
const contractCaseNames = Object.freeze([
  "harness:component-evidence",
  "harness:sanitized-native-mapping",
  "harness:launcher-and-installation",
  "harness:fail-open-deadline",
  "harness:scenario-adapter",
]);

const canonicalEvidenceValue = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value.map((member) => canonicalEvidenceValue(member));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalEvidenceValue(record[key])]),
    );
  }
  return value;
};

const evidenceDigest = (value: unknown): string =>
  `sha256-${createHash("sha256")
    .update(JSON.stringify(canonicalEvidenceValue(value)))
    .digest("hex")}`;

const parseContextEvidence = (
  value: unknown,
): HarnessContractContextEvidence => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HarnessContractAssertionError(
      "harness.contract.context-evidence",
    );
  const { prototype, descriptors } = (() => {
    try {
      return {
        prototype: Object.getPrototypeOf(value) as object | null,
        descriptors: Object.getOwnPropertyDescriptors(value),
      };
    } catch {
      throw new HarnessContractAssertionError(
        "harness.contract.context-evidence",
      );
    }
  })();
  const keys = Reflect.ownKeys(descriptors);
  const expected = [
    "evidenceVersion",
    "mappingArtifactDigest",
    "contextDigest",
  ];
  if (
    prototype !== Object.prototype ||
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    throw new HarnessContractAssertionError(
      "harness.contract.context-evidence",
    );
  const member = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor))
      throw new HarnessContractAssertionError(
        "harness.contract.context-evidence",
      );
    return descriptor.value;
  };
  const evidenceVersion = member("evidenceVersion");
  const mappingArtifactDigest = member("mappingArtifactDigest");
  const contextDigest = member("contextDigest");
  if (
    evidenceVersion !== 1 ||
    typeof mappingArtifactDigest !== "string" ||
    !digestPattern.test(mappingArtifactDigest) ||
    typeof contextDigest !== "string" ||
    !digestPattern.test(contextDigest)
  )
    throw new HarnessContractAssertionError(
      "harness.contract.context-evidence",
    );
  return Object.freeze({
    evidenceVersion: 1 as const,
    mappingArtifactDigest,
    contextDigest,
  });
};

export const deriveHarnessComponentEvidenceDigest = (
  fixture: HarnessSanitizedFixture,
  scenario: HarnessScenarioAdapter,
  descriptor: HarnessDescriptor,
  contextEvidence: unknown,
): `component-sha256-${string}` => {
  const boundContextEvidence = parseContextEvidence(contextEvidence);
  return `component-${evidenceDigest({
    evidenceVersion: 1,
    cases: contractCaseNames,
    descriptor,
    fixture,
    scenario,
    contextEvidence: boundContextEvidence,
  })}` as `component-sha256-${string}`;
};

const fixtureIsSanitized = (fixture: HarnessSanitizedFixture): boolean => {
  try {
    parseHarnessSanitizedFixture(fixture);
    return true;
  } catch {
    return false;
  }
};

const componentEvidenceIsBound = (
  adapter: HarnessComponentContractAdapter,
): boolean => {
  const evidence = adapter.componentEvidence;
  const expected = deriveHarnessComponentEvidenceDigest(
    adapter.fixture,
    adapter.scenario,
    adapter.descriptor,
    adapter.contextEvidence,
  );
  const compatibleVersion = parseStableSemver(adapter.compatibleVersion);
  const owningRange =
    compatibleVersion === undefined
      ? undefined
      : adapter.descriptor.compatibility.find((range) => {
          const minimum = parseStableSemver(range.minimumInclusive);
          const maximum = parseStableSemver(range.maximumExclusive);
          return (
            minimum !== undefined &&
            maximum !== undefined &&
            stableSemverIsInRange(compatibleVersion, minimum, maximum)
          );
        });
  return (
    owningRange !== undefined &&
    owningRange.evidenceSlot === evidence.evidenceSlot &&
    evidence.evidenceVersion === 1 &&
    evidence.harnessType === adapter.descriptor.harnessType &&
    evidence.testedVersion === adapter.compatibleVersion &&
    evidence.fixtureId === adapter.fixture.fixtureId &&
    evidence.scenarioId === adapter.scenario.scenarioId &&
    evidence.evidenceSlot ===
      adapter.fixture.governance.representative.evidenceSlot &&
    evidence.componentDigest === expected
  );
};

const installationInput = (
  root: string,
  operation: "install" | "migrate" | "uninstall",
  planner: HarnessInstallationPlanner,
) => ({
  manifestPath: join(root, "transactions", `${operation}.json`),
  operation,
  targetPaths: [join(root, "harness-config.json")],
  planner,
});

const runInstallationContract = async (
  adapter: HarnessComponentContractAdapter,
  invocation: OwnedHarnessHookInvocation,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-harness-contract-"));
  const target = join(root, "harness-config.json");
  try {
    const install = await inspectHarnessInstallation(
      installationInput(
        root,
        "install",
        adapter.createInstallationPlanner("install", invocation),
      ),
    );
    const installed = await applyHarnessInstallation(install);
    assert(
      installed.ok && installed.state === "committed",
      "harness.contract.install.owned",
    );
    const ownedBytes = await readFile(target);

    const uninstall = await inspectHarnessInstallation(
      installationInput(
        root,
        "uninstall",
        adapter.createInstallationPlanner("uninstall", invocation),
      ),
    );
    const uninstalled = await applyHarnessInstallation(uninstall);
    assert(
      uninstalled.ok && uninstalled.state === "committed",
      "harness.contract.install.uninstall",
    );

    await writeFile(target, "unsupported-native-format");
    const unsupported = await inspectHarnessInstallation(
      installationInput(
        root,
        "install",
        adapter.createInstallationPlanner("install", invocation),
      ),
    );
    assert(
      unsupported.disposition === "unsupported",
      "harness.contract.install.unsupported",
    );

    await writeFile(target, "vendor-observability-hook");
    const vendorUninstall = await inspectHarnessInstallation(
      installationInput(
        root,
        "uninstall",
        adapter.createInstallationPlanner("uninstall", invocation),
      ),
    );
    assert(
      vendorUninstall.disposition === "unchanged" &&
        (await readFile(target, "utf8")) === "vendor-observability-hook",
      "harness.contract.install.uninstall-ownership",
    );
    const conflict = await inspectHarnessInstallation(
      installationInput(
        root,
        "install",
        adapter.createInstallationPlanner("install", invocation),
      ),
    );
    assert(
      conflict.disposition === "conflict",
      "harness.contract.install.overlap",
    );
    const migration = await inspectHarnessInstallation(
      installationInput(
        root,
        "migrate",
        adapter.createInstallationPlanner("migrate", invocation),
      ),
    );
    const migrated = await applyHarnessInstallation(migration);
    assert(
      migrated.ok &&
        migrated.state === "committed" &&
        (await readFile(target)).equals(ownedBytes),
      "harness.contract.install.migrate",
    );

    await rm(target);
    const concurrent = await inspectHarnessInstallation(
      installationInput(
        root,
        "install",
        adapter.createInstallationPlanner("install", invocation),
      ),
    );
    await writeFile(target, "concurrent-vendor-edit");
    const rejected = await applyHarnessInstallation(concurrent);
    assert(
      !rejected.ok &&
        rejected.state === "conflict" &&
        (await readFile(target, "utf8")) === "concurrent-vendor-edit",
      "harness.contract.install.concurrent-edit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runDeadlineContract = async (
  adapter: HarnessComponentContractAdapter,
): Promise<void> => {
  assert(
    (await adapter.runHook("success", new AbortController().signal)) ===
      "completed",
    "harness.contract.hook.success",
  );
  assert(
    (await adapter.runHook("failure", new AbortController().signal)) ===
      "failed-open",
    "harness.contract.hook.fail-open",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 5);
  let guard!: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([
      adapter.runHook("hang", controller.signal),
      new Promise<"late">((resolve) => {
        guard = setTimeout(() => {
          resolve("late");
        }, 100);
      }),
    ]);
    assert(outcome === "failed-open", "harness.contract.hook.deadline");
  } finally {
    clearTimeout(timer);
    clearTimeout(guard);
  }
};

const resolvedAssertion = (operation: () => void): Promise<void> => {
  operation();
  return Promise.resolve();
};

const runMappingContract = (adapter: HarnessComponentContractAdapter): void => {
  assert(
    fixtureIsSanitized(adapter.fixture) &&
      adapter.fixture.harnessVersion === adapter.compatibleVersion,
    "harness.contract.fixture.sanitized",
  );
  let resolutions = 0;
  let checkpointRequest: NativeCheckpointRequest | undefined;
  const mapping = adapter.mapFixture((request) => {
    resolutions += 1;
    checkpointRequest = request;
    return Object.freeze({
      disposition: "retained" as const,
      startPosition: request.availableStartPosition,
    });
  });
  assert(
    checkpointRequest !== undefined &&
      checkpointRequest.nativeIdentity === adapter.fixture.nativeIdentity &&
      checkpointRequest.nativeIdentityKind ===
        adapter.fixture.nativeIdentityKind &&
      checkpointRequest.sourceGeneration === adapter.fixture.sourceGeneration &&
      checkpointRequest.positionKind === adapter.fixture.positionKind &&
      checkpointRequest.availableStartPosition ===
        adapter.fixture.availableStartPosition,
    "harness.contract.mapping.checkpoint",
  );
  const fields = [...mapping.provenance, ...mapping.unavailable].map(
    ({ field }) => field,
  );
  assert(
    resolutions === 1 &&
      mapping.boundary.session.kind === "native-session" &&
      mapping.boundary.session.nativeIdentity ===
        adapter.fixture.nativeIdentity &&
      mapping.boundary.session.nativeIdentityKind ===
        adapter.fixture.nativeIdentityKind &&
      mapping.boundary.generation === adapter.fixture.sourceGeneration &&
      mapping.boundary.positionKind === adapter.fixture.positionKind &&
      mapping.boundary.boundaryKind === adapter.fixture.boundaryKind &&
      mapping.boundary.boundaryId === adapter.fixture.boundaryId &&
      mapping.boundary.startPosition ===
        adapter.fixture.availableStartPosition &&
      mapping.boundary.exclusiveEndPosition ===
        adapter.fixture.exclusiveEndPosition &&
      [...fields].sort().join("\0") ===
        [...adapter.fixture.expectedFields].sort().join("\0"),
    "harness.contract.mapping",
  );
};

const runScenarioContract = (
  adapter: HarnessComponentContractAdapter,
): void => {
  const scenario = adapter.scenario;
  assert(
    scenario.scenarioVersion === 1 &&
      idPattern.test(scenario.scenarioId) &&
      scenario.harnessId ===
        adapter.descriptor.harnessType.replace("@agentscope/harness-", "") &&
      scenario.harnessPackage === adapter.descriptor.harnessType &&
      packagePattern.test(scenario.harnessPackage) &&
      scenario.representativeVersion === adapter.compatibleVersion &&
      scenario.fixtureId === adapter.fixture.fixtureId &&
      adapter.fixture.harnessId === scenario.harnessId &&
      adapter.fixture.governance.representative.scenarioId ===
        scenario.scenarioId &&
      adapter.fixture.governance.representative.representativeVersion ===
        scenario.representativeVersion &&
      scenario.tags.length > 0 &&
      scenario.commandArguments.every(
        (argument) => argument.length > 0 && !shellSyntax.test(argument),
      ),
    "harness.contract.scenario",
  );
};

export const createHarnessContractSuite = (
  adapter: HarnessComponentContractAdapter,
): readonly HarnessContractCase[] => {
  return Object.freeze([
    Object.freeze({
      name: "harness:component-evidence",
      run: () =>
        resolvedAssertion(() => {
          assert(
            componentEvidenceIsBound(adapter),
            "harness.contract.component-evidence",
          );
        }),
    }),
    Object.freeze({
      name: "harness:sanitized-native-mapping",
      run: () =>
        resolvedAssertion(() => {
          runMappingContract(adapter);
        }),
    }),
    Object.freeze({
      name: "harness:launcher-and-installation",
      run: async () => {
        const invocation = createOwnedHarnessHookInvocation({
          agentscopeHome: "/opt/agentscope",
          harnessType: adapter.descriptor.harnessType,
          hookDeadlineMilliseconds: 2_000,
          platform: "posix",
        });
        assert(
          invocation.arguments.length === 0 &&
            invocation.launcherPath.startsWith("/opt/agentscope/bin/") &&
            !shellSyntax.test(invocation.launcherPath),
          "harness.contract.launcher.arguments",
        );
        await runInstallationContract(adapter, invocation);
      },
    }),
    Object.freeze({
      name: "harness:fail-open-deadline",
      run: () => runDeadlineContract(adapter),
    }),
    Object.freeze({
      name: "harness:scenario-adapter",
      run: () =>
        resolvedAssertion(() => {
          runScenarioContract(adapter);
        }),
    }),
  ]);
};
