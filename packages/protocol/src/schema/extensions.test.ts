import { describe, expect, it } from "vitest";

import { standardsManifest } from "../standards/manifest.js";
import {
  agentscopeExtensionRegistry,
  type ExtensionRegistryInput,
  ExtensionRegistryError,
  fingerprintExtensionEntries,
  getAgentscopeExtension,
  validateExtensionRegistry,
} from "./extensions.js";

type Registry = ExtensionRegistryInput;

const registryFixture = (): Registry =>
  structuredClone(standardsManifest.agentscopeExtensions) as Registry;

const resign = (registry: Registry) => {
  registry.registryFingerprint = fingerprintExtensionEntries(registry.entries);
  return registry;
};

describe("Agentscope extension registry governance", () => {
  it("loads a deeply frozen, queryable default registry", () => {
    expect(agentscopeExtensionRegistry.length).toBeGreaterThan(5);
    expect(getAgentscopeExtension("agentscope.harness.name")).toMatchObject({
      contentClass: "identifier",
      originTrust: "native-controlled",
      sensitivity: "potentially-sensitive",
      redaction: "identifier-policy",
      provenanceField: "agentscope.harness.name",
    });
    expect(getAgentscopeExtension("agentscope.unknown.value")).toBeUndefined();
    expect(Object.isFrozen(agentscopeExtensionRegistry)).toBe(true);
    expect(Object.isFrozen(agentscopeExtensionRegistry[0])).toBe(true);
  });

  it("rejects semantic changes without a matching SHA-256 identity", () => {
    const registry = registryFixture();
    registry.entries[0]!.provenanceRule = "changed without identity";
    expect(() => validateExtensionRegistry(registry)).toThrow(
      "changed without an identity update",
    );
  });

  it("rejects a valid resigned registry when the manifest identity is stale", () => {
    const registry = registryFixture();
    registry.entries[8]!.provenanceRule = "intentional semantic change";
    expect(() => validateExtensionRegistry(resign(registry))).toThrow(
      "Protocol manifest identity does not bind the extension registry",
    );
  });

  it.each([
    [
      "duplicate key",
      (registry: Registry) => {
        registry.entries[1]!.key = registry.entries[0]!.key;
      },
    ],
    [
      "duplicate semantic",
      (registry: Registry) => {
        registry.entries[1]!.semantic = registry.entries[0]!.semantic;
      },
    ],
    [
      "standard semantic collision",
      (registry: Registry) => {
        registry.entries[1]!.semantic = "vcs.ref.head.name";
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const registry = registryFixture();
    mutate(registry);
    expect(() => validateExtensionRegistry(resign(registry))).toThrow(
      ExtensionRegistryError,
    );
  });
});

describe("Agentscope extension descriptor consistency", () => {
  it.each([
    [
      "json shape mismatch",
      (registry: Registry) => {
        registry.entries[1]!.valueType = "json-string";
      },
    ],
    [
      "safe redaction mismatch",
      (registry: Registry) => {
        registry.entries[1]!.redaction = "path-policy";
      },
    ],
    [
      "sensitive retain mismatch",
      (registry: Registry) => {
        registry.entries[5]!.redaction = "retain";
      },
    ],
    [
      "native-controlled safe mismatch",
      (registry: Registry) => {
        registry.entries[3]!.sensitivity = "safe";
        registry.entries[3]!.redaction = "retain";
      },
    ],
    [
      "location route mismatch",
      (registry: Registry) => {
        registry.entries[5]!.redaction = "identifier-policy";
      },
    ],
    [
      "fixed structural origin mismatch",
      (registry: Registry) => {
        registry.entries[0]!.originTrust = "core-registry-owned";
      },
    ],
    [
      "structured metadata origin mismatch",
      (registry: Registry) => {
        registry.entries[2]!.originTrust = "protocol-owned";
      },
    ],
    [
      "unknown span kind",
      (registry: Registry) => {
        registry.entries[1]!.openInferenceKinds = ["FUTURE_KIND"];
      },
    ],
    [
      "baseline mismatch",
      (registry: Registry) => {
        registry.entries[1]!.introducedInProtocolContractVersion = 3;
      },
    ],
    [
      "missing required descriptor",
      (registry: Registry) => {
        registry.entries = registry.entries.filter(
          ({ key }) => key !== "agentscope.mapping.provenance",
        );
      },
    ],
  ] as const)(
    "rejects inconsistent descriptor metadata: %s",
    (_label, mutate) => {
      const registry = registryFixture();
      mutate(registry);
      expect(() => validateExtensionRegistry(resign(registry))).toThrow(
        ExtensionRegistryError,
      );
    },
  );

  it("rejects malformed namespace grammar before governance", () => {
    const registry = registryFixture();
    registry.entries[1]!.key = "agentscope..Hidden Value";
    expect(() => validateExtensionRegistry(resign(registry))).toThrow();
  });
});
