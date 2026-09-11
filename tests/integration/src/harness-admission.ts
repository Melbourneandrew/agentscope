import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

const digestPattern = /^sha256-[a-f0-9]{64}$/u;
const ociDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const componentDigestPattern = /^component-sha256-[a-f0-9]{64}$/u;
const harnessPattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const imagePattern = /^[a-z0-9][a-z0-9./_-]{0,159}@sha256:[a-f0-9]{64}$/u;
const semverPattern = /^\d+\.\d+\.\d+$/u;
const runPattern = /^[a-f0-9]{16}$/u;

export type HarnessAdmissionControllerSnapshot = Readonly<{
  active: boolean;
  authorityIdentity: string;
  candidateIdentities: ReadonlySet<string>;
  hostKind: "crabbox" | "github-hosted";
  receipts: ReadonlyMap<
    string,
    Readonly<{
      requestFingerprint: string;
      transport: "headless" | "pty";
    }>
  >;
  runIds: ReadonlySet<string>;
  workspaceRevision: string;
}>;

export type HarnessAdmissionSeed = Readonly<{
  admissionVersion: 1;
  runId: string;
  candidateDigest: string;
  manifestIdentity: string;
  scenarioId: string;
  catalogRowIdentity: string;
  productIdentity: "agentscope-cli";
  harness: Readonly<{
    registryIdentity: string;
    evidenceSlot: string;
    exactVersion: string;
    eligibleRange: Readonly<{
      minimumInclusive: string;
      maximumExclusive: string;
    }>;
    distributionReference: string;
    artifactDigest: string;
    artifactAuthorityDigest: string;
  }>;
  execution: Readonly<{
    mode: "headless" | "interactive";
    outputContract: "jsonl" | "semantic-pty";
  }>;
  component: Readonly<{
    fixtureDigest: string;
    adapterArtifactDigest: string;
    mappingArtifactDigest: string;
    componentEvidenceDigest: string;
  }>;
  platformIdentity: string;
  destinationCombinationIdentity: string;
  preparedImage: Readonly<{
    image: string;
    manifestDigest: string;
    configDigest: string;
    platformIdentity: string;
  }>;
}>;

export type HarnessAdmissionCompletion = Readonly<{
  completionVersion: 1;
  runId: string;
  requestFingerprint: string;
  observationPlaneDigest: string;
  cleanupEvidenceDigest: string;
  outcome: "scenario-terminal-clean";
  remainingOwnedResources: 0;
}>;

export type HarnessAdmissionAuthority = Readonly<{
  authorityVersion: 1;
  runId: string;
}>;

export type AuthenticatedHarnessMaterialAuthority = Readonly<{
  authorityVersion: 1;
  authorityKind: "authenticated-harness-material";
}>;

export type AuthenticatedHarnessTerminalAuthority = Readonly<{
  authorityVersion: 1;
  authorityKind: "authenticated-harness-terminal";
}>;

export type HarnessSupportEvidenceManifest = Readonly<{
  manifestVersion: 1;
  disposition: "real-scenario-evidence-awaiting-release-gate";
  manifestIdentity: string;
  entries: readonly Readonly<{
    harnessType: string;
    evidenceSlot: string;
    testedVersion: string;
    catalogRowIdentity: string;
    contractSuiteDigest: string;
    realScenarioDigest: string;
    binding: Readonly<{
      seed: HarnessAdmissionSeed;
      controller: Readonly<{
        authorityIdentity: string;
        hostKind: "crabbox" | "github-hosted";
        workspaceRevision: string;
      }>;
      completion: HarnessAdmissionCompletion;
    }>;
  }>[];
}>;

type AdmissionState<Token extends object> = {
  completed?: Readonly<{
    completion: HarnessAdmissionCompletion;
    controller: Readonly<{
      authorityIdentity: string;
      hostKind: "crabbox" | "github-hosted";
      workspaceRevision: string;
    }>;
  }>;
  consumed: boolean;
  material: AuthenticatedHarnessMaterialAuthority;
  seed: HarnessAdmissionSeed;
  token: Token;
};

type DataRecord = Readonly<Record<string, unknown>>;

const invalid = (): never => {
  throw new Error("integration.harness-admission.invalid");
};

const authenticateValue = <T>(operation: () => T | undefined): T => {
  try {
    const value = operation();
    return value === undefined ? invalid() : value;
  } catch {
    return invalid();
  }
};

const exactRecord = (value: unknown, keys: readonly string[]): DataRecord => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return invalid();
      output[key] = descriptor.value as unknown;
    }
    return output;
  } catch {
    return invalid();
  }
};

const exactArray = (value: unknown, maximum = 32): readonly unknown[] => {
  try {
    if (!Array.isArray(value)) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && "value" in lengthDescriptor
        ? (lengthDescriptor.value as unknown)
        : undefined;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 1 ||
      (length as number) > maximum ||
      Reflect.ownKeys(descriptors).length !== (length as number) + 1
    )
      return invalid();
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return invalid();
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return invalid();
  }
};

const text = (value: unknown, pattern: RegExp, maximum = 256): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !pattern.test(value)
  )
    return invalid();
  return value;
};

const parseSemver = (value: string): readonly [number, number, number] => {
  if (!semverPattern.test(value)) return invalid();
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 3 ||
    parts.some(
      (part, index) =>
        !Number.isSafeInteger(part) ||
        part < 0 ||
        part > 2_147_483_647 ||
        String(part) !== value.split(".")[index],
    )
  )
    return invalid();
  return parts as unknown as readonly [number, number, number];
};

const compareSemver = (
  left: readonly number[],
  right: readonly number[],
): number => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
};

const harnessArtifactAuthorityIdentity = (
  input: Readonly<{
    registryIdentity: string;
    exactVersion: string;
    distributionReference: string;
    artifactDigest: string;
  }>,
): string => sha256(canonicalJson(input));

const harnessCatalogRowIdentity = (
  input: Readonly<{
    productIdentity: "agentscope-cli";
    harness: Readonly<{
      registryIdentity: string;
      evidenceSlot: string;
      exactVersion: string;
    }>;
    execution: Readonly<{
      mode: "headless" | "interactive";
      outputContract: "jsonl" | "semantic-pty";
    }>;
    platformIdentity: string;
    destinationCombinationIdentity: string;
  }>,
): string => sha256(canonicalJson(input));

const parseHarness = (value: unknown): HarnessAdmissionSeed["harness"] => {
  const harness = exactRecord(value, [
    "registryIdentity",
    "evidenceSlot",
    "exactVersion",
    "eligibleRange",
    "distributionReference",
    "artifactDigest",
    "artifactAuthorityDigest",
  ]);
  const eligibleRange = exactRecord(harness.eligibleRange, [
    "minimumInclusive",
    "maximumExclusive",
  ]);
  const exactVersion = text(harness.exactVersion, semverPattern, 64);
  const minimumInclusive = text(
    eligibleRange.minimumInclusive,
    semverPattern,
    64,
  );
  const maximumExclusive = text(
    eligibleRange.maximumExclusive,
    semverPattern,
    64,
  );
  const exact = parseSemver(exactVersion);
  const minimum = parseSemver(minimumInclusive);
  const maximum = parseSemver(maximumExclusive);
  if (
    compareSemver(minimum, maximum) >= 0 ||
    compareSemver(exact, minimum) < 0 ||
    compareSemver(exact, maximum) >= 0
  )
    return invalid();
  return {
    registryIdentity: text(harness.registryIdentity, harnessPattern, 128),
    evidenceSlot: text(harness.evidenceSlot, idPattern, 64),
    exactVersion,
    eligibleRange: { minimumInclusive, maximumExclusive },
    distributionReference: text(
      harness.distributionReference,
      /^[A-Za-z0-9][A-Za-z0-9+._:@/-]{0,255}$/u,
      256,
    ),
    artifactDigest: text(harness.artifactDigest, digestPattern, 71),
    artifactAuthorityDigest: text(
      harness.artifactAuthorityDigest,
      digestPattern,
      71,
    ),
  };
};

const parseExecution = (value: unknown): HarnessAdmissionSeed["execution"] => {
  const execution = exactRecord(value, ["mode", "outputContract"]);
  if (
    (execution.mode !== "headless" && execution.mode !== "interactive") ||
    (execution.outputContract !== "jsonl" &&
      execution.outputContract !== "semantic-pty") ||
    (execution.mode === "headless" && execution.outputContract !== "jsonl") ||
    (execution.mode === "interactive" &&
      execution.outputContract !== "semantic-pty")
  )
    return invalid();
  return { mode: execution.mode, outputContract: execution.outputContract };
};

const parseComponent = (value: unknown): HarnessAdmissionSeed["component"] => {
  const component = exactRecord(value, [
    "fixtureDigest",
    "adapterArtifactDigest",
    "mappingArtifactDigest",
    "componentEvidenceDigest",
  ]);
  return {
    fixtureDigest: text(component.fixtureDigest, digestPattern, 71),
    adapterArtifactDigest: text(
      component.adapterArtifactDigest,
      digestPattern,
      71,
    ),
    mappingArtifactDigest: text(
      component.mappingArtifactDigest,
      digestPattern,
      71,
    ),
    componentEvidenceDigest: text(
      component.componentEvidenceDigest,
      componentDigestPattern,
      81,
    ),
  };
};

const parsePreparedImage = (
  value: unknown,
): HarnessAdmissionSeed["preparedImage"] => {
  const preparedImage = exactRecord(value, [
    "image",
    "manifestDigest",
    "configDigest",
    "platformIdentity",
  ]);
  return {
    image: text(preparedImage.image, imagePattern, 232),
    manifestDigest: text(preparedImage.manifestDigest, ociDigestPattern, 71),
    configDigest: text(preparedImage.configDigest, ociDigestPattern, 71),
    platformIdentity: text(preparedImage.platformIdentity, digestPattern, 71),
  };
};

const parseSeed = (value: unknown): HarnessAdmissionSeed => {
  const record = exactRecord(value, [
    "admissionVersion",
    "runId",
    "candidateDigest",
    "manifestIdentity",
    "scenarioId",
    "catalogRowIdentity",
    "productIdentity",
    "harness",
    "execution",
    "component",
    "platformIdentity",
    "destinationCombinationIdentity",
    "preparedImage",
  ]);
  if (
    record.admissionVersion !== 1 ||
    record.productIdentity !== "agentscope-cli"
  )
    return invalid();
  const harness = parseHarness(record.harness);
  const execution = parseExecution(record.execution);
  const component = parseComponent(record.component);
  const preparedImage = parsePreparedImage(record.preparedImage);
  const parsed = deepFreeze({
    admissionVersion: 1 as const,
    runId: text(record.runId, runPattern, 16),
    candidateDigest: text(record.candidateDigest, digestPattern, 71),
    manifestIdentity: text(record.manifestIdentity, digestPattern, 71),
    scenarioId: text(record.scenarioId, idPattern, 64),
    catalogRowIdentity: text(record.catalogRowIdentity, digestPattern, 71),
    productIdentity: "agentscope-cli" as const,
    harness,
    execution,
    component,
    platformIdentity: text(record.platformIdentity, digestPattern, 71),
    destinationCombinationIdentity: text(
      record.destinationCombinationIdentity,
      digestPattern,
      71,
    ),
    preparedImage,
  });
  if (
    parsed.harness.artifactAuthorityDigest !==
      harnessArtifactAuthorityIdentity({
        registryIdentity: parsed.harness.registryIdentity,
        exactVersion: parsed.harness.exactVersion,
        distributionReference: parsed.harness.distributionReference,
        artifactDigest: parsed.harness.artifactDigest,
      }) ||
    parsed.catalogRowIdentity !==
      harnessCatalogRowIdentity({
        productIdentity: parsed.productIdentity,
        harness: {
          registryIdentity: parsed.harness.registryIdentity,
          evidenceSlot: parsed.harness.evidenceSlot,
          exactVersion: parsed.harness.exactVersion,
        },
        execution: parsed.execution,
        platformIdentity: parsed.platformIdentity,
        destinationCombinationIdentity: parsed.destinationCombinationIdentity,
      })
  )
    return invalid();
  return parsed;
};

const parseCompletion = (value: unknown): HarnessAdmissionCompletion => {
  const record = exactRecord(value, [
    "completionVersion",
    "runId",
    "requestFingerprint",
    "observationPlaneDigest",
    "cleanupEvidenceDigest",
    "outcome",
    "remainingOwnedResources",
  ]);
  if (
    record.completionVersion !== 1 ||
    record.outcome !== "scenario-terminal-clean" ||
    record.remainingOwnedResources !== 0
  )
    return invalid();
  return deepFreeze({
    completionVersion: 1,
    runId: text(record.runId, runPattern, 16),
    requestFingerprint: text(record.requestFingerprint, ociDigestPattern, 71),
    observationPlaneDigest: text(
      record.observationPlaneDigest,
      digestPattern,
      71,
    ),
    cleanupEvidenceDigest: text(
      record.cleanupEvidenceDigest,
      digestPattern,
      71,
    ),
    outcome: "scenario-terminal-clean" as const,
    remainingOwnedResources: 0,
  });
};

export type HarnessAdmissionKernel<Token extends object> = Readonly<{
  begin: (
    token: Token,
    material: AuthenticatedHarnessMaterialAuthority,
  ) => HarnessAdmissionAuthority;
  complete: (
    token: Token,
    authority: HarnessAdmissionAuthority,
    terminal: AuthenticatedHarnessTerminalAuthority,
  ) => void;
  compile: (
    token: Token,
    authorities: readonly HarnessAdmissionAuthority[],
  ) => HarnessSupportEvidenceManifest;
}>;

type KernelStorage<Token extends object> = Readonly<{
  states: WeakMap<object, AdmissionState<Token>>;
  claimedMaterials: WeakSet<object>;
  snapshot: (token: Token) => HarnessAdmissionControllerSnapshot;
  authenticateMaterial: (
    token: Token,
    authority: AuthenticatedHarnessMaterialAuthority,
  ) => unknown;
  authenticateTerminal: (
    token: Token,
    authority: AuthenticatedHarnessTerminalAuthority,
  ) => unknown;
}>;

const compileManifest = <Token extends object>(
  storage: KernelStorage<Token>,
  token: Token,
  values: readonly HarnessAdmissionAuthority[],
): HarnessSupportEvidenceManifest => {
  storage.snapshot(token);
  const authorities = exactArray(values, 64);
  const seen = new Set<string>();
  const resolved = authorities.map((authority) => {
    const state = storage.states.get(authority as object);
    if (
      !state ||
      state.token !== token ||
      state.consumed ||
      state.completed === undefined
    )
      return invalid();
    const identity = state.seed.catalogRowIdentity;
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    return state;
  });
  const entries = resolved
    .map((state) => {
      const contractSuiteDigest = sha256(
        canonicalJson({
          adapterArtifactDigest: state.seed.component.adapterArtifactDigest,
          componentEvidenceDigest: state.seed.component.componentEvidenceDigest,
          fixtureDigest: state.seed.component.fixtureDigest,
          mappingArtifactDigest: state.seed.component.mappingArtifactDigest,
        }),
      );
      const binding = deepFreeze({
        controller: state.completed!.controller,
        seed: state.seed,
        completion: state.completed!.completion,
      });
      return Object.freeze({
        harnessType: state.seed.harness.registryIdentity,
        evidenceSlot: state.seed.harness.evidenceSlot,
        testedVersion: state.seed.harness.exactVersion,
        catalogRowIdentity: state.seed.catalogRowIdentity,
        contractSuiteDigest,
        realScenarioDigest: sha256(canonicalJson(binding)),
        binding,
      });
    })
    .sort((left, right) =>
      left.catalogRowIdentity.localeCompare(right.catalogRowIdentity),
    );
  for (const state of resolved) state.consumed = true;
  const material = Object.freeze({
    manifestVersion: 1 as const,
    disposition: "real-scenario-evidence-awaiting-release-gate" as const,
    entries,
  });
  return deepFreeze({
    ...material,
    manifestIdentity: sha256(canonicalJson(material)),
  });
};

const admissionMethods = <Token extends object>(
  storage: KernelStorage<Token>,
) => {
  const begin = (
    token: Token,
    material: AuthenticatedHarnessMaterialAuthority,
  ): HarnessAdmissionAuthority => {
    const controller = storage.snapshot(token);
    const seed = parseSeed(
      authenticateValue(() => storage.authenticateMaterial(token, material)),
    );
    if (
      storage.claimedMaterials.has(material) ||
      !controller.runIds.has(seed.runId) ||
      !controller.candidateIdentities.has(seed.candidateDigest) ||
      seed.preparedImage.platformIdentity !== seed.platformIdentity
    )
      return invalid();
    storage.claimedMaterials.add(material);
    const authority = Object.freeze({
      authorityVersion: 1 as const,
      runId: seed.runId,
    });
    storage.states.set(authority, {
      consumed: false,
      material,
      seed,
      token,
    });
    return authority;
  };
  const complete = (
    token: Token,
    authority: HarnessAdmissionAuthority,
    terminal: AuthenticatedHarnessTerminalAuthority,
  ): void => {
    const controller = storage.snapshot(token);
    const state = storage.states.get(authority);
    const terminalRecord = exactRecord(
      authenticateValue(() => storage.authenticateTerminal(token, terminal)),
      ["material", "completion"],
    );
    const completion = parseCompletion(terminalRecord.completion);
    const receipt = controller.receipts.get(completion.runId);
    if (
      !state ||
      state.token !== token ||
      state.consumed ||
      state.completed !== undefined ||
      terminalRecord.material !== state.material ||
      completion.runId !== state.seed.runId ||
      receipt?.requestFingerprint !== completion.requestFingerprint ||
      receipt.transport !==
        (state.seed.execution.mode === "headless" ? "headless" : "pty")
    )
      return invalid();
    state.completed = deepFreeze({
      completion,
      controller: {
        authorityIdentity: controller.authorityIdentity,
        hostKind: controller.hostKind,
        workspaceRevision: controller.workspaceRevision,
      },
    });
  };
  const compile = (
    token: Token,
    values: readonly HarnessAdmissionAuthority[],
  ): HarnessSupportEvidenceManifest => compileManifest(storage, token, values);
  return { begin, complete, compile };
};

export const createHarnessAdmissionKernel = <Token extends object>(
  authenticate: (
    token: Token,
  ) => HarnessAdmissionControllerSnapshot | undefined,
  authenticateMaterial: KernelStorage<Token>["authenticateMaterial"],
  authenticateTerminal: KernelStorage<Token>["authenticateTerminal"],
): HarnessAdmissionKernel<Token> => {
  const snapshot = (token: Token): HarnessAdmissionControllerSnapshot => {
    const value = authenticateValue(() => authenticate(token));
    if (value?.active !== true) return invalid();
    return value;
  };
  const storage: KernelStorage<Token> = {
    states: new WeakMap(),
    claimedMaterials: new WeakSet(),
    snapshot,
    authenticateMaterial,
    authenticateTerminal,
  };
  return Object.freeze({
    ...admissionMethods(storage),
  });
};
