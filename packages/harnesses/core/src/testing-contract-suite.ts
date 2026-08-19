import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileHarnessRegistry } from "./descriptor.js";
import { discoverHarness } from "./discovery.js";
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
  NativeCheckpointResolver,
  NativeFieldProvenance,
  NativeUnavailableField,
} from "./native-mapping.js";
import type {
  HarnessDescriptor,
  HarnessSupportEvidenceManifest,
} from "./types.js";

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

export type HarnessSanitizedFixture = Readonly<{
  fixtureVersion: 1;
  fixtureId: string;
  harnessVersion: string;
  nativeIdentityKind: "run" | "session" | "thread";
  nativeIdentity: string;
  sourceGeneration: number;
  positionKind: "byte-offset" | "event-index" | "line" | "sequence";
  availableStartPosition: number;
  boundaryKind: "hook-invocation" | "session" | "transcript-range" | "turn";
  boundaryId: string;
  exclusiveEndPosition: number;
  expectedFields: readonly string[];
  sanitizedPayload: Readonly<Record<string, string | number | boolean>>;
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

export type HarnessContractAdapter = Readonly<{
  descriptor: HarnessDescriptor;
  supportEvidence: HarnessSupportEvidenceManifest;
  compatibleVersion: string;
  unsupportedVersion: string;
  fixture: HarnessSanitizedFixture;
  scenario: HarnessScenarioAdapter;
  contextEvidence: Uint8Array;
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
const forbiddenFixtureText =
  /(?:bearer\s|api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|\/Users\/|\/home\/|[A-Za-z]:\\)/iu;
const shellSyntax = /(?:[;&|`$<>\n\r]|\$\(|\{\{)/u;
const contractCaseNames = Object.freeze([
  "harness:compatibility-evidence",
  "harness:discovery",
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

export const deriveHarnessContractEvidenceDigests = (
  fixture: HarnessSanitizedFixture,
  scenario: HarnessScenarioAdapter,
): Readonly<{ contractSuiteDigest: string; realScenarioDigest: string }> =>
  Object.freeze({
    contractSuiteDigest: evidenceDigest({
      contractVersion: 1,
      cases: contractCaseNames,
    }),
    realScenarioDigest: evidenceDigest({ fixture, scenario }),
  });

const fixtureIsSanitized = (fixture: HarnessSanitizedFixture): boolean => {
  try {
    const serialized = JSON.stringify(fixture);
    return (
      fixture.fixtureVersion === 1 &&
      idPattern.test(fixture.fixtureId) &&
      fixture.expectedFields.length > 0 &&
      new Set(fixture.expectedFields).size === fixture.expectedFields.length &&
      !forbiddenFixtureText.test(serialized)
    );
  } catch {
    return false;
  }
};

const evidenceIsBound = (adapter: HarnessContractAdapter): boolean => {
  const entry = adapter.supportEvidence.entries.find(
    (candidate) =>
      candidate.harnessType === adapter.descriptor.harnessType &&
      candidate.testedVersion === adapter.compatibleVersion,
  );
  if (!entry) return false;
  const expected = deriveHarnessContractEvidenceDigests(
    adapter.fixture,
    adapter.scenario,
  );
  return (
    digestPattern.test(entry.contractSuiteDigest) &&
    digestPattern.test(entry.realScenarioDigest) &&
    entry.contractSuiteDigest === expected.contractSuiteDigest &&
    entry.realScenarioDigest === expected.realScenarioDigest
  );
};

const discoveryProbe = (adapter: HarnessContractAdapter, version: string) => ({
  locateExecutable: () =>
    Promise.resolve({
      kind: "found" as const,
      candidates: [{ path: "/opt/agentscope-contract/harness" }],
    }),
  readVersion: () =>
    Promise.resolve({
      kind: "observed" as const,
      output: `${adapter.descriptor.executable.versionPrefix}${version}${adapter.descriptor.executable.versionSuffix}`,
    }),
  inspectConfiguration: () =>
    Promise.resolve(
      adapter.descriptor.configuration.locationSegments.map(
        (_, locationIndex) => ({
          locationIndex,
          present: locationIndex === 0,
        }),
      ),
    ),
});

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
  adapter: HarnessContractAdapter,
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
  adapter: HarnessContractAdapter,
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

const runMappingContract = (adapter: HarnessContractAdapter): void => {
  assert(
    fixtureIsSanitized(adapter.fixture) &&
      adapter.fixture.harnessVersion === adapter.compatibleVersion,
    "harness.contract.fixture.sanitized",
  );
  let resolutions = 0;
  const mapping = adapter.mapFixture((request) => {
    resolutions += 1;
    assert(
      request.nativeIdentity === adapter.fixture.nativeIdentity &&
        request.availableStartPosition ===
          adapter.fixture.availableStartPosition,
      "harness.contract.mapping.checkpoint",
    );
    return Object.freeze({
      disposition: "retained" as const,
      startPosition: request.availableStartPosition,
    });
  });
  const fields = [...mapping.provenance, ...mapping.unavailable].map(
    ({ field }) => field,
  );
  assert(
    resolutions === 1 &&
      mapping.boundary.session.kind === "native-session" &&
      mapping.boundary.session.nativeIdentity ===
        adapter.fixture.nativeIdentity &&
      mapping.boundary.startPosition ===
        adapter.fixture.availableStartPosition &&
      mapping.boundary.exclusiveEndPosition ===
        adapter.fixture.exclusiveEndPosition &&
      [...fields].sort().join("\0") ===
        [...adapter.fixture.expectedFields].sort().join("\0"),
    "harness.contract.mapping",
  );
};

const runScenarioContract = (adapter: HarnessContractAdapter): void => {
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
      scenario.tags.length > 0 &&
      scenario.commandArguments.every(
        (argument) => argument.length > 0 && !shellSyntax.test(argument),
      ),
    "harness.contract.scenario",
  );
};

export const createHarnessContractSuite = (
  adapter: HarnessContractAdapter,
): readonly HarnessContractCase[] => {
  const registry = compileHarnessRegistry(
    [adapter.descriptor],
    adapter.supportEvidence,
  );
  return Object.freeze([
    Object.freeze({
      name: "harness:compatibility-evidence",
      run: () =>
        resolvedAssertion(() => {
          assert(evidenceIsBound(adapter), "harness.contract.compatibility");
        }),
    }),
    Object.freeze({
      name: "harness:discovery",
      run: async () => {
        const compatible = await discoverHarness(
          registry,
          adapter.descriptor.harnessType,
          discoveryProbe(adapter, adapter.compatibleVersion),
        );
        const unsupported = await discoverHarness(
          registry,
          adapter.descriptor.harnessType,
          discoveryProbe(adapter, adapter.unsupportedVersion),
        );
        assert(
          compatible.state === "installed" &&
            compatible.reason === "compatible" &&
            unsupported.state === "unsupported" &&
            unsupported.reason === "version-unsupported",
          "harness.contract.discovery",
        );
      },
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
          executablePath: "/opt/agentscope/bin/agentscope",
          harnessType: adapter.descriptor.harnessType,
          contextEvidence: adapter.contextEvidence,
        });
        assert(
          invocation.arguments.length === 5 &&
            invocation.arguments[0] === "capture-hook-v1" &&
            invocation.arguments[4] === adapter.descriptor.harnessType &&
            invocation.arguments.every(
              (argument) => !shellSyntax.test(argument),
            ),
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
