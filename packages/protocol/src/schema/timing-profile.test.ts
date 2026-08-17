import { describe, expect, it } from "vitest";

import { fingerprintCanonicalMaterial } from "./extensions.js";
import {
  createTimingProvenanceValue,
  getTimingCompatibilityRule,
  isTimingProvenanceCompatible,
  NATIVE_STATES,
  PROVENANCE_SOURCES,
  TIMING_BASES,
  TIMING_LOCATIONS,
  TIMING_PROFILE_FINGERPRINT,
  timingProfile,
  TimingProfileError,
  validateTimingProfileIdentity,
  validateTimingProfileForTesting,
} from "./timing-profile.js";

const acceptedTimingCombinations = [
  ["native-interval", "observed", "hook-payload", "root-span", "interval"],
  ["native-interval", "observed", "hook-payload", "span", "interval"],
  ["native-interval", "observed", "native-artifact", "root-span", "interval"],
  ["native-interval", "observed", "native-artifact", "span", "interval"],
  ["native-point", "observed", "hook-payload", "root-span", "point"],
  ["native-point", "observed", "hook-payload", "span", "point"],
  ["native-point", "observed", "native-artifact", "root-span", "point"],
  ["native-point", "observed", "native-artifact", "span", "point"],
  ["artifact-point", "unavailable", "native-artifact", "root-span", "point"],
  ["artifact-point", "unavailable", "native-artifact", "span", "point"],
  ["hook-observed-point", "unavailable", "process", "root-span", "point"],
  ["hook-observed-point", "unavailable", "process", "span", "point"],
  ["derived-child-envelope", "unavailable", "derived", "root-span", "interval"],
] as const;
const acceptedTimingKeys = new Set(
  acceptedTimingCombinations.map(([basis, state, source, location]) =>
    [basis, state, source, location].join("|"),
  ),
);
const allTimingCombinations = TIMING_BASES.flatMap((timingBasis) =>
  NATIVE_STATES.flatMap((nativeState) =>
    PROVENANCE_SOURCES.flatMap((source) =>
      TIMING_LOCATIONS.map((location) => ({
        timingBasis,
        nativeState,
        source,
        location,
      })),
    ),
  ),
);

describe("timing compatibility profile", () => {
  it("defines every basis exactly once and binds its canonical fingerprint", () => {
    expect(
      timingProfile.rules.map(({ timingBasis }) => timingBasis).sort(),
    ).toEqual([...TIMING_BASES].sort());
    expect(fingerprintCanonicalMaterial(timingProfile)).toBe(
      TIMING_PROFILE_FINGERPRINT,
    );
    const nativeState = timingProfile.rules[0]!.nativeState;
    const replacement = nativeState === "observed" ? "unavailable" : "observed";
    expect(
      Reflect.set(timingProfile.rules[0]!, "nativeState", replacement),
    ).toBe(false);
    expect(timingProfile.rules[0]!.nativeState).toBe(nativeState);
  });

  it.each(acceptedTimingCombinations)(
    "accepts %s/%s from %s",
    (timingBasis, nativeState, source, location, shape) => {
      expect(
        isTimingProvenanceCompatible({
          timingBasis,
          nativeState,
          source,
          location,
        }),
      ).toBe(true);
      expect(getTimingCompatibilityRule(timingBasis).shape).toBe(shape);
      expect(
        createTimingProvenanceValue({ timingBasis, source, location }),
      ).toEqual({
        timingBasis,
        source,
        nativeState,
      });
    },
  );

  it("rejects every non-descriptor basis/state/source combination", () => {
    for (const combination of allTimingCombinations) {
      expect(isTimingProvenanceCompatible(combination)).toBe(
        acceptedTimingKeys.has(
          [
            combination.timingBasis,
            combination.nativeState,
            combination.source,
            combination.location,
          ].join("|"),
        ),
      );
    }
  });
});

describe("timing profile rejection", () => {
  it("rejects unsupported construction sources with a sanitized error", () => {
    expect(() =>
      createTimingProvenanceValue({
        timingBasis: "hook-observed-point",
        source: "native-artifact",
        location: "span",
      }),
    ).toThrowError("protocol.timing-profile.invalid");
    expect(() => {
      validateTimingProfileIdentity("sha256-stale");
    }).toThrowError("protocol.timing-profile.invalid");
    expect(() => {
      validateTimingProfileIdentity(TIMING_PROFILE_FINGERPRINT, 2);
    }).toThrowError("protocol.timing-profile.invalid");
    expect(() => getTimingCompatibilityRule("attacker" as never)).toThrowError(
      "protocol.timing-profile.invalid",
    );
  });

  it("rejects duplicate, missing, malformed, and repeated-source rules", () => {
    const duplicate = {
      ...timingProfile,
      rules: timingProfile.rules.map((rule, index) =>
        index === 1 ? timingProfile.rules[0]! : rule,
      ),
    };
    expect(() => validateTimingProfileForTesting(duplicate)).toThrow(
      TimingProfileError,
    );

    const missing = {
      ...timingProfile,
      rules: timingProfile.rules.slice(0, -1),
    };
    expect(() => validateTimingProfileForTesting(missing)).toThrow(
      TimingProfileError,
    );

    const repeatedSource = {
      ...timingProfile,
      rules: timingProfile.rules.map((rule, index) =>
        index === 0
          ? {
              ...rule,
              allowedSources: [...rule.allowedSources, rule.allowedSources[0]!],
            }
          : rule,
      ),
    };
    expect(() => validateTimingProfileForTesting(repeatedSource)).toThrow(
      TimingProfileError,
    );

    expect(() =>
      validateTimingProfileForTesting({
        descriptorVersion: 1,
        rules: [{ timingBasis: "attacker" }],
      }),
    ).toThrow(TimingProfileError);
  });

  it("rejects changes to every load-bearing exact timing rule", () => {
    const mutatedProfiles = [
      {
        ...timingProfile,
        rules: timingProfile.rules.map((rule) =>
          rule.timingBasis === "native-interval"
            ? { ...rule, shape: "point" }
            : rule,
        ),
      },
      {
        ...timingProfile,
        rules: timingProfile.rules.map((rule) =>
          rule.timingBasis === "native-point"
            ? { ...rule, nativeState: "unavailable" }
            : rule,
        ),
      },
      {
        ...timingProfile,
        rules: timingProfile.rules.map((rule) =>
          rule.timingBasis === "artifact-point"
            ? { ...rule, allowedSources: ["git"] }
            : rule,
        ),
      },
      {
        ...timingProfile,
        rules: timingProfile.rules.map((rule) =>
          rule.timingBasis === "hook-observed-point"
            ? { ...rule, evidenceClass: "native-operation-time" }
            : rule,
        ),
      },
    ];
    for (const profile of mutatedProfiles) {
      expect(() => validateTimingProfileForTesting(profile)).toThrow(
        TimingProfileError,
      );
    }
  });
});
