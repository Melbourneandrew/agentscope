import {
  compareStableSemver,
  parseStableSemver,
  stableSemverIsInRange,
} from "./semver.js";
import type {
  HarnessCompatibilityRange,
  HarnessDescriptor,
  HarnessDescriptorInput,
  HarnessExecutableProbe,
  HarnessRangeEvidence,
  HarnessRegistry,
  HarnessSupportEvidenceManifest,
  HarnessTypeId,
} from "./types.js";

const maximumDescriptors = 32;
const maximumRanges = 8;
const maximumExecutableNames = 8;
const maximumConfigurationLocations = 16;
const maximumSegments = 16;
const maximumArguments = 16;
const maximumTextLength = 128;
const harnessTypePattern = /^@agentscope\/harness-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const tokenPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const executablePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const locationSegmentPattern = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const digestPattern = /^sha256-[a-f0-9]{64}$/;

const descriptorState = new WeakSet<object>();
const registryState = new WeakMap<
  object,
  ReadonlyMap<HarnessTypeId, HarnessDescriptor>
>();

export class HarnessDescriptorError extends Error {
  public constructor() {
    super("harness.descriptor.invalid");
    this.name = "HarnessDescriptorError";
  }
}

const invalid = (): never => {
  throw new HarnessDescriptorError();
};

const ownDescriptors = (value: object): PropertyDescriptorMap => {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(value)) return invalid();
  const descriptors = ownDescriptors(value);
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
  return Object.freeze(output);
};

const denseArray = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value)) return invalid();
  const descriptors = ownDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  /* v8 ignore next -- native arrays always expose their nonconfigurable data length. */
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return invalid();
  const length: unknown = lengthDescriptor.value as unknown;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > maximum
  )
    return invalid();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some((key) => typeof key === "symbol"))
    return invalid();
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    /* v8 ignore next -- exact key cardinality above proves every dense numeric descriptor exists. */
    if (!descriptor || !("value" in descriptor)) return invalid();
    output.push(descriptor.value as unknown);
  }
  return Object.freeze(output);
};

const boundedString = (
  value: unknown,
  pattern?: RegExp,
  maximum = maximumTextLength,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  )
    return invalid();
  return value;
};

const stringArray = (
  value: unknown,
  maximum: number,
  pattern?: RegExp,
): readonly string[] =>
  Object.freeze(
    denseArray(value, maximum).map((entry) => boundedString(entry, pattern)),
  );

const parseRange = (value: unknown): HarnessCompatibilityRange => {
  const record = exactRecord(value, [
    "minimumInclusive",
    "maximumExclusive",
    "evidenceSlot",
  ]);
  const minimumInclusive = boundedString(record.minimumInclusive);
  const maximumExclusive = boundedString(record.maximumExclusive);
  const minimum = parseStableSemver(minimumInclusive);
  const maximum = parseStableSemver(maximumExclusive);
  if (!minimum || !maximum || compareStableSemver(minimum, maximum) >= 0)
    return invalid();
  return Object.freeze({
    minimumInclusive,
    maximumExclusive,
    evidenceSlot: boundedString(record.evidenceSlot, tokenPattern),
  });
};

const rangesOverlap = (
  left: HarnessCompatibilityRange,
  right: HarnessCompatibilityRange,
): boolean => {
  const leftMinimum = parseStableSemver(left.minimumInclusive)!;
  const leftMaximum = parseStableSemver(left.maximumExclusive)!;
  const rightMinimum = parseStableSemver(right.minimumInclusive)!;
  const rightMaximum = parseStableSemver(right.maximumExclusive)!;
  return (
    compareStableSemver(leftMinimum, rightMaximum) < 0 &&
    compareStableSemver(rightMinimum, leftMaximum) < 0
  );
};

const parseExecutable = (value: unknown): HarnessExecutableProbe => {
  const record = exactRecord(value, [
    "names",
    "versionArguments",
    "versionPrefix",
    "versionSuffix",
  ]);
  const names = stringArray(
    record.names,
    maximumExecutableNames,
    executablePattern,
  );
  if (new Set(names).size !== names.length) return invalid();
  return Object.freeze({
    names,
    versionArguments: stringArray(record.versionArguments, maximumArguments),
    versionPrefix:
      record.versionPrefix === "" ? "" : boundedString(record.versionPrefix),
    versionSuffix:
      record.versionSuffix === "" ? "" : boundedString(record.versionSuffix),
  });
};

const parseDescriptor = (input: HarnessDescriptorInput): HarnessDescriptor => {
  const record = exactRecord(input, [
    "descriptorVersion",
    "harnessType",
    "executable",
    "configuration",
    "compatibility",
    "nativeSource",
  ]);
  if (record.descriptorVersion !== 1) return invalid();
  const configuration = exactRecord(record.configuration, ["locationSegments"]);
  const locationSegments = Object.freeze(
    denseArray(
      configuration.locationSegments,
      maximumConfigurationLocations,
    ).map((segments) =>
      stringArray(segments, maximumSegments, locationSegmentPattern),
    ),
  );
  const compatibility = Object.freeze(
    denseArray(record.compatibility, maximumRanges).map(parseRange),
  );
  const slots = new Set(compatibility.map((range) => range.evidenceSlot));
  if (slots.size !== compatibility.length) return invalid();
  for (let index = 0; index < compatibility.length; index += 1)
    for (let other = index + 1; other < compatibility.length; other += 1)
      if (rangesOverlap(compatibility[index]!, compatibility[other]!))
        return invalid();
  const nativeSource = exactRecord(record.nativeSource, [
    "sourceKind",
    "continuityVersion",
  ]);
  if (
    !Number.isSafeInteger(nativeSource.continuityVersion) ||
    (nativeSource.continuityVersion as number) < 1 ||
    (nativeSource.continuityVersion as number) > 65_535
  )
    return invalid();
  const descriptor = Object.freeze({
    descriptorVersion: 1 as const,
    harnessType: boundedString(
      record.harnessType,
      harnessTypePattern,
    ) as HarnessTypeId,
    executable: parseExecutable(record.executable),
    configuration: Object.freeze({ locationSegments }),
    compatibility,
    nativeSource: Object.freeze({
      sourceKind: boundedString(nativeSource.sourceKind, tokenPattern),
      continuityVersion: nativeSource.continuityVersion as number,
    }),
  }) as HarnessDescriptor;
  descriptorState.add(descriptor);
  return descriptor;
};

export const defineHarnessDescriptor = (
  input: HarnessDescriptorInput,
): HarnessDescriptor => parseDescriptor(input);

const parseEvidence = (value: unknown): HarnessRangeEvidence => {
  const record = exactRecord(value, [
    "harnessType",
    "evidenceSlot",
    "testedVersion",
    "contractSuiteDigest",
    "realScenarioDigest",
  ]);
  const testedVersion = boundedString(record.testedVersion);
  if (!parseStableSemver(testedVersion)) return invalid();
  return Object.freeze({
    harnessType: boundedString(record.harnessType, harnessTypePattern),
    evidenceSlot: boundedString(record.evidenceSlot, tokenPattern),
    testedVersion,
    contractSuiteDigest: boundedString(
      record.contractSuiteDigest,
      digestPattern,
    ),
    realScenarioDigest: boundedString(record.realScenarioDigest, digestPattern),
  });
};

export const compileHarnessRegistry = (
  descriptorsInput: readonly HarnessDescriptor[],
  evidenceInput: HarnessSupportEvidenceManifest,
): HarnessRegistry => {
  const descriptors = denseArray(descriptorsInput, maximumDescriptors).map(
    (descriptor) => {
      if (!isHarnessDescriptor(descriptor)) return invalid();
      return descriptor;
    },
  );
  const evidenceRecord = exactRecord(evidenceInput, [
    "manifestVersion",
    "entries",
  ]);
  if (evidenceRecord.manifestVersion !== 1) return invalid();
  const entries = denseArray(
    evidenceRecord.entries,
    maximumDescriptors * maximumRanges,
  ).map(parseEvidence);
  const byType = new Map<HarnessTypeId, HarnessDescriptor>();
  const required = new Map<string, HarnessCompatibilityRange>();
  for (const descriptor of descriptors) {
    if (byType.has(descriptor.harnessType)) return invalid();
    byType.set(descriptor.harnessType, descriptor);
    for (const range of descriptor.compatibility)
      required.set(
        `${descriptor.harnessType}\u0000${range.evidenceSlot}`,
        range,
      );
  }
  if (required.size !== entries.length) return invalid();
  const observed = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.harnessType}\u0000${entry.evidenceSlot}`;
    const range = required.get(key);
    const version = parseStableSemver(entry.testedVersion);
    if (
      !range ||
      !version ||
      observed.has(key) ||
      !stableSemverIsInRange(
        version,
        parseStableSemver(range.minimumInclusive)!,
        parseStableSemver(range.maximumExclusive)!,
      )
    )
      return invalid();
    observed.add(key);
  }
  const registry = Object.freeze({
    descriptorVersion: 1 as const,
    harnessTypes: Object.freeze([...byType.keys()].sort()),
  }) as HarnessRegistry;
  registryState.set(registry, new Map(byType));
  return registry;
};

export const isHarnessDescriptor = (
  value: unknown,
): value is HarnessDescriptor =>
  typeof value === "object" && value !== null && descriptorState.has(value);

export const isHarnessRegistry = (value: unknown): value is HarnessRegistry =>
  typeof value === "object" && value !== null && registryState.has(value);

export const getHarnessDescriptor = (
  registry: HarnessRegistry,
  harnessType: string,
): HarnessDescriptor | undefined =>
  registryState.get(registry)?.get(harnessType as HarnessTypeId);
