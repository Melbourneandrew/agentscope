import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";

import {
  invalid,
  exactRecord,
  exactArray,
  parseSeed,
  parseCompletion,
  type HarnessAdmissionSeed,
  type HarnessAdmissionCompletion,
  type HarnessSupportEvidenceManifest,
} from "./harness-admission-data.js";
export {
  parsePersistedHarnessSupportEvidence,
  type HarnessAdmissionSeed,
  type HarnessAdmissionCompletion,
  type HarnessSupportEvidenceManifest,
} from "./harness-admission-data.js";

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

const authenticateValue = <T>(operation: () => T | undefined): T => {
  try {
    const value = operation();
    return value === undefined ? invalid() : value;
  } catch {
    return invalid();
  }
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
      completion.scenarioImageDigest !==
        state.seed.preparedImage.scenarioImageDigest ||
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
