export type HarnessTypeId = string & {
  readonly __harnessTypeId: unique symbol;
};

export type StableSemver = Readonly<{
  major: number;
  minor: number;
  patch: number;
  text: string;
}>;

export type HarnessCompatibilityRange = Readonly<{
  minimumInclusive: string;
  maximumExclusive: string;
  evidenceSlot: string;
}>;

export type HarnessExecutableProbe = Readonly<{
  names: readonly string[];
  versionArguments: readonly string[];
  versionPrefix: string;
  versionSuffix: string;
}>;

export type HarnessConfigurationProbe = Readonly<{
  locationSegments: readonly (readonly string[])[];
}>;

export type HarnessNativeSourceDeclaration = Readonly<{
  sourceKind: string;
  continuityVersion: number;
}>;

export type HarnessDescriptorInput = Readonly<{
  descriptorVersion: 1;
  harnessType: string;
  executable: HarnessExecutableProbe;
  configuration: HarnessConfigurationProbe;
  compatibility: readonly HarnessCompatibilityRange[];
  nativeSource: HarnessNativeSourceDeclaration;
}>;

declare const harnessDescriptorBrand: unique symbol;

export type HarnessDescriptor = Readonly<{
  descriptorVersion: 1;
  harnessType: HarnessTypeId;
  executable: HarnessExecutableProbe;
  configuration: HarnessConfigurationProbe;
  compatibility: readonly HarnessCompatibilityRange[];
  nativeSource: HarnessNativeSourceDeclaration;
  readonly [harnessDescriptorBrand]: true;
}>;

export type HarnessRangeEvidence = Readonly<{
  harnessType: string;
  evidenceSlot: string;
  testedVersion: string;
  contractSuiteDigest: string;
  realScenarioDigest: string;
}>;

export type HarnessSupportEvidenceManifest = Readonly<{
  manifestVersion: 1;
  entries: readonly HarnessRangeEvidence[];
}>;

declare const harnessRegistryBrand: unique symbol;

export type HarnessRegistry = Readonly<{
  descriptorVersion: 1;
  harnessTypes: readonly HarnessTypeId[];
  readonly [harnessRegistryBrand]: true;
}>;

export type HarnessExecutableCandidate = Readonly<{
  path: string;
}>;

export type HarnessExecutableProbeResult =
  | Readonly<{
      kind: "found";
      candidates: readonly HarnessExecutableCandidate[];
    }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable" }>;

export type HarnessVersionProbeResult =
  | Readonly<{ kind: "observed"; output: string }>
  | Readonly<{ kind: "unavailable" }>;

export type HarnessConfigurationProbeResult = Readonly<{
  locationIndex: number;
  present: boolean;
}>;

export interface HarnessDiscoveryProbe {
  locateExecutable(
    names: readonly string[],
  ): Promise<HarnessExecutableProbeResult>;
  readVersion(
    executablePath: string,
    arguments_: readonly string[],
  ): Promise<HarnessVersionProbeResult>;
  inspectConfiguration(
    locations: readonly (readonly string[])[],
  ): Promise<readonly HarnessConfigurationProbeResult[]>;
}

export type HarnessDiscoveryState =
  "installed" | "absent" | "unsupported" | "indeterminate";

export type HarnessDiscoveryReason =
  | "compatible"
  | "not-found"
  | "probe-unavailable"
  | "ambiguous-executable"
  | "version-unavailable"
  | "version-invalid"
  | "version-unsupported";

export type HarnessDiscoveryResult = Readonly<{
  harnessType: HarnessTypeId;
  state: HarnessDiscoveryState;
  reason: HarnessDiscoveryReason;
  version: string | null;
  configurationLocations: readonly HarnessConfigurationProbeResult[];
}>;

export type HarnessInspectionResult<State> = Readonly<{
  state: State;
  fingerprint: string;
}>;

export type HarnessApplyResult<State> = Readonly<{
  state: State;
  changed: boolean;
}>;

export type HarnessVerifyResult = Readonly<{
  verified: boolean;
  code: "verified" | "conflict" | "unsupported" | "unavailable";
}>;

export interface HarnessIntegrationOperations<InspectInput, ApplyInput, State> {
  inspect(input: InspectInput): Promise<HarnessInspectionResult<State>>;
  apply(input: ApplyInput): Promise<HarnessApplyResult<State>>;
  verify(state: State): Promise<HarnessVerifyResult>;
}
