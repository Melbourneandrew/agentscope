import { isAbsolute } from "node:path";

import { getHarnessDescriptor, isHarnessRegistry } from "./descriptor.js";
import { parseStableSemver, stableSemverIsInRange } from "./semver.js";
import type {
  HarnessConfigurationProbeResult,
  HarnessDiscoveryProbe,
  HarnessDiscoveryReason,
  HarnessDiscoveryResult,
  HarnessDiscoveryState,
  HarnessExecutableCandidate,
  HarnessExecutableProbeResult,
  HarnessRegistry,
  HarnessVersionProbeResult,
} from "./types.js";

const maximumCandidates = 16;
const maximumPathLength = 4_096;
const maximumVersionOutputLength = 4_096;

export class HarnessDiscoveryError extends Error {
  public constructor() {
    super("harness.discovery.invalid");
    this.name = "HarnessDiscoveryError";
  }
}

const invalid = (): never => {
  throw new HarnessDiscoveryError();
};

const exactDataRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value as unknown;
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
};

const denseDataArray = (
  value: unknown,
  maximum: number,
): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    /* v8 ignore next -- native arrays always expose their nonconfigurable data length. */
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length: unknown = lengthDescriptor.value as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum
    )
      return undefined;
    if (
      Reflect.ownKeys(descriptors).length !== length + 1 ||
      Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      /* v8 ignore next -- exact key cardinality above proves every dense numeric descriptor exists. */
      if (!descriptor || !("value" in descriptor)) return undefined;
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
};

const parseExecutableResult = (
  value: unknown,
): HarnessExecutableProbeResult | undefined => {
  const kindOnly = exactDataRecord(value, ["kind"]);
  if (kindOnly?.kind === "absent") return Object.freeze({ kind: "absent" });
  if (kindOnly?.kind === "unavailable")
    return Object.freeze({ kind: "unavailable" });
  const found = exactDataRecord(value, ["kind", "candidates"]);
  if (found?.kind !== "found") return undefined;
  const input = denseDataArray(found.candidates, maximumCandidates);
  if (!input || input.length === 0) return undefined;
  const candidates: HarnessExecutableCandidate[] = [];
  for (const candidate of input) {
    const record = exactDataRecord(candidate, ["path"]);
    if (
      !record ||
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      record.path.length > maximumPathLength ||
      !isAbsolute(record.path)
    )
      return undefined;
    candidates.push(Object.freeze({ path: record.path }));
  }
  return Object.freeze({
    kind: "found",
    candidates: Object.freeze(candidates),
  });
};

const parseVersionResult = (
  value: unknown,
): HarnessVersionProbeResult | undefined => {
  const unavailable = exactDataRecord(value, ["kind"]);
  if (unavailable?.kind === "unavailable")
    return Object.freeze({ kind: "unavailable" });
  const observed = exactDataRecord(value, ["kind", "output"]);
  if (
    observed?.kind !== "observed" ||
    typeof observed.output !== "string" ||
    observed.output.length > maximumVersionOutputLength
  )
    return undefined;
  return Object.freeze({ kind: "observed", output: observed.output });
};

const parseConfigurationResults = (
  value: unknown,
  locationCount: number,
): readonly HarnessConfigurationProbeResult[] => {
  const input = denseDataArray(value, locationCount);
  if (!input || input.length !== locationCount) return Object.freeze([]);
  const output: HarnessConfigurationProbeResult[] = [];
  const seen = new Set<number>();
  for (const entry of input) {
    const record = exactDataRecord(entry, ["locationIndex", "present"]);
    if (
      !record ||
      !Number.isSafeInteger(record.locationIndex) ||
      (record.locationIndex as number) < 0 ||
      (record.locationIndex as number) >= locationCount ||
      typeof record.present !== "boolean" ||
      seen.has(record.locationIndex as number)
    )
      return Object.freeze([]);
    seen.add(record.locationIndex as number);
    output.push(
      Object.freeze({
        locationIndex: record.locationIndex as number,
        present: record.present,
      }),
    );
  }
  output.sort((left, right) => left.locationIndex - right.locationIndex);
  return Object.freeze(output);
};

const result = (
  harnessType: HarnessDiscoveryResult["harnessType"],
  state: HarnessDiscoveryState,
  reason: HarnessDiscoveryReason,
  version: string | null,
  configurationLocations: readonly HarnessConfigurationProbeResult[],
): HarnessDiscoveryResult =>
  Object.freeze({
    harnessType,
    state,
    reason,
    version,
    configurationLocations,
  });

const extractVersion = (
  output: string,
  prefix: string,
  suffix: string,
): string | undefined => {
  const trimmed = output.trim();
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(suffix))
    return undefined;
  const end =
    suffix.length === 0 ? trimmed.length : trimmed.length - suffix.length;
  const version = trimmed.slice(prefix.length, end);
  return parseStableSemver(version)?.text;
};

const inspectConfiguration = async (
  probe: HarnessDiscoveryProbe,
  locations: readonly (readonly string[])[],
): Promise<readonly HarnessConfigurationProbeResult[]> => {
  try {
    return parseConfigurationResults(
      await probe.inspectConfiguration(locations),
      locations.length,
    );
  } catch {
    return Object.freeze([]);
  }
};

export const discoverHarness = async (
  registry: HarnessRegistry,
  harnessType: string,
  probe: HarnessDiscoveryProbe,
): Promise<HarnessDiscoveryResult> => {
  if (!isHarnessRegistry(registry)) return invalid();
  const descriptor = getHarnessDescriptor(registry, harnessType);
  if (!descriptor) return invalid();
  const configurationPromise = inspectConfiguration(
    probe,
    descriptor.configuration.locationSegments,
  );
  let executable: HarnessExecutableProbeResult | undefined;
  try {
    executable = parseExecutableResult(
      await probe.locateExecutable(descriptor.executable.names),
    );
  } catch {
    executable = undefined;
  }
  const configuration = await configurationPromise;
  if (!executable)
    return result(
      descriptor.harnessType,
      "indeterminate",
      "probe-unavailable",
      null,
      configuration,
    );
  if (executable.kind === "absent")
    return result(
      descriptor.harnessType,
      "absent",
      "not-found",
      null,
      configuration,
    );
  if (executable.kind === "unavailable")
    return result(
      descriptor.harnessType,
      "indeterminate",
      "probe-unavailable",
      null,
      configuration,
    );
  if (executable.candidates.length !== 1)
    return result(
      descriptor.harnessType,
      "indeterminate",
      "ambiguous-executable",
      null,
      configuration,
    );
  let versionResult: HarnessVersionProbeResult | undefined;
  try {
    versionResult = parseVersionResult(
      await probe.readVersion(
        executable.candidates[0]!.path,
        descriptor.executable.versionArguments,
      ),
    );
  } catch {
    versionResult = undefined;
  }
  if (!versionResult || versionResult.kind === "unavailable")
    return result(
      descriptor.harnessType,
      "indeterminate",
      "version-unavailable",
      null,
      configuration,
    );
  const versionText = extractVersion(
    versionResult.output,
    descriptor.executable.versionPrefix,
    descriptor.executable.versionSuffix,
  );
  const version = versionText && parseStableSemver(versionText);
  if (!version)
    return result(
      descriptor.harnessType,
      "indeterminate",
      "version-invalid",
      null,
      configuration,
    );
  const compatible = descriptor.compatibility.some((range) =>
    stableSemverIsInRange(
      version,
      parseStableSemver(range.minimumInclusive)!,
      parseStableSemver(range.maximumExclusive)!,
    ),
  );
  return compatible
    ? result(
        descriptor.harnessType,
        "installed",
        "compatible",
        version.text,
        configuration,
      )
    : result(
        descriptor.harnessType,
        "unsupported",
        "version-unsupported",
        version.text,
        configuration,
      );
};
