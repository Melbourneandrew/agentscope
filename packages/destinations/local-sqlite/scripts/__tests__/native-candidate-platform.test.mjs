import { describe, expect, it } from "vitest";

import {
  ensurePlatformImage,
  nativeCandidatePlatform,
} from "../../native-candidate/tooling/image-platform-authority.mjs";

const toolchain = Object.freeze({
  reference:
    "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2",
  expectedId:
    "sha256:a1bea2f8c1ee78866f82039a60baa1c3a480872018aa0ef4891000ec793ed82b",
});
const execution = Object.freeze({
  reference:
    "node@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5",
  expectedId:
    "sha256:955b467cb9a2a941cb181f7cf1d2405c1dd24b4566a3598b7eae7ecca1a769d1",
});
const inspection = (expectedId, architecture = "amd64") =>
  Object.freeze({
    error: undefined,
    status: 0,
    stdout: `${expectedId}\tlinux\t${architecture}\t\n`,
  });
const missing = Object.freeze({ error: undefined, status: 1, stdout: "" });
const pulled = Object.freeze({ error: undefined, status: 0, stdout: "" });

describe("native candidate platform image authority", () => {
  it.each([toolchain, execution])(
    "pulls and inspects $reference only for the admitted platform",
    (authority) => {
      const observed = [];
      const results = [missing, pulled, inspection(authority.expectedId)];

      ensurePlatformImage({
        ...authority,
        invoke(arguments_) {
          observed.push(arguments_);
          return results.shift();
        },
      });

      expect(results).toEqual([]);
      expect(observed).toEqual([
        [
          "image",
          "inspect",
          "--platform",
          "linux/amd64",
          authority.reference,
          "--format",
          "{{.Id}}\t{{.Os}}\t{{.Architecture}}\t{{.Variant}}",
        ],
        ["pull", "--platform", "linux/amd64", authority.reference],
        [
          "image",
          "inspect",
          "--platform",
          "linux/amd64",
          authority.reference,
          "--format",
          "{{.Id}}\t{{.Os}}\t{{.Architecture}}\t{{.Variant}}",
        ],
      ]);
    },
  );

  it("rejects a host-default arm64 selection without adopting it", () => {
    let invocations = 0;
    expect(() =>
      ensurePlatformImage({
        ...toolchain,
        invoke() {
          invocations += 1;
          return inspection(
            "sha256:9054c406605ceabba8948fd6817fcf2120b27f18de3e20a0c5eb6e12bf23b89a",
            "arm64",
          );
        },
      }),
    ).toThrow("native candidate image identity mismatch");
    expect(invocations).toBe(1);
  });

  it.each([
    [
      "config substitution",
      inspection(
        "sha256:9054c406605ceabba8948fd6817fcf2120b27f18de3e20a0c5eb6e12bf23b89a",
      ),
    ],
    [
      "operating-system substitution",
      {
        ...inspection(toolchain.expectedId),
        stdout: `${toolchain.expectedId}\tdarwin\tamd64\t\n`,
      },
    ],
    [
      "variant substitution",
      {
        ...inspection(toolchain.expectedId),
        stdout: `${toolchain.expectedId}\tlinux\tamd64\tv8\n`,
      },
    ],
  ])("rejects %s after platform-exact inspection", (_name, result) => {
    expect(() =>
      ensurePlatformImage({
        ...toolchain,
        invoke: () => result,
      }),
    ).toThrow("native candidate image identity mismatch");
  });

  it("owns one canonical platform tuple", () => {
    expect(nativeCandidatePlatform).toEqual({
      docker: "linux/amd64",
      os: "linux",
      architecture: "amd64",
      variant: "",
    });
  });
});
