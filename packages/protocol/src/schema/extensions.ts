import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import { createHash } from "node:crypto";
import { z } from "zod";

import { standardsManifest } from "../standards/manifest.js";

const extensionDescriptorSchema = z
  .object({
    key: z
      .string()
      .max(128)
      .regex(/^agentscope\.[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*)+$/u),
    semantic: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*)+$/u),
    valueType: z.enum(["string", "json-string"]),
    jsonShape: z
      .enum([
        "agentscope.field-provenance.v1",
        "agentscope.field-unavailable.v1",
      ])
      .optional(),
    applicability: z.enum(["resource", "root-span", "span"]),
    contentClass: z.enum([
      "fixed-structural",
      "identifier",
      "location",
      "structured-metadata",
    ]),
    originTrust: z.enum([
      "protocol-owned",
      "core-registry-owned",
      "derived-metadata",
      "native-controlled",
    ]),
    sensitivity: z.enum(["safe", "potentially-sensitive"]),
    redaction: z.enum(["retain", "identifier-policy", "path-policy"]),
    requirementLevel: z.enum(["required", "conditional"]),
    provenanceRule: z.string().min(1),
    provenanceField: z
      .string()
      .max(128)
      .regex(/^agentscope\.[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*)+$/u)
      .optional(),
    introducedInProtocolContractVersion: z.number().int().positive(),
    openInferenceKinds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const extensionRegistrySchema = z
  .object({
    registryVersion: z.number().int().positive(),
    registryFingerprint: z.string().regex(/^sha256-[\da-f]{64}$/u),
    namespace: z.literal("agentscope."),
    unknownKeyPolicy: z.literal("reject"),
    entries: z.array(extensionDescriptorSchema).min(1),
  })
  .strict();

export type ExtensionRegistryInput = z.input<typeof extensionRegistrySchema>;

type ParsedExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;
export type AgentscopeExtensionDescriptor = Omit<
  ParsedExtensionDescriptor,
  "openInferenceKinds"
> & {
  readonly openInferenceKinds?: readonly string[] | undefined;
};

export type ExtensionApplicability =
  AgentscopeExtensionDescriptor["applicability"];

const openInferenceSemantics = new Set<string>(
  Object.values(SemanticConventions),
);
const reservedStandardSemantics = new Set([
  ...openInferenceSemantics,
  "service.name",
  "service.version",
  "telemetry.sdk.name",
  "telemetry.sdk.version",
  "vcs.ref.head.name",
  "vcs.ref.head.revision",
  "vcs.ref.type",
  "vcs.repository.name",
  "vcs.repository.url.full",
  "error.type",
  "exception.type",
  "exception.message",
  "exception.stacktrace",
  "exception.escaped",
]);

const findDuplicate = (values: readonly string[]): string | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
};

export const fingerprintCanonicalMaterial = (material: unknown) => {
  const digest = createHash("sha256")
    .update(JSON.stringify(material), "utf8")
    .digest("hex");
  return `sha256-${digest}`;
};

export const fingerprintExtensionEntries = (entries: readonly unknown[]) =>
  fingerprintCanonicalMaterial(entries);

export class ExtensionRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtensionRegistryError";
  }
}

const validateDescriptorMetadata = (entry: ParsedExtensionDescriptor) => {
  if (reservedStandardSemantics.has(entry.semantic)) {
    throw new ExtensionRegistryError(
      `Extension duplicates a standard semantic: ${entry.semantic}`,
    );
  }
  if ((entry.valueType === "json-string") !== (entry.jsonShape !== undefined)) {
    throw new ExtensionRegistryError(
      "JSON extension descriptor has inconsistent shape metadata",
    );
  }
  if (
    (entry.sensitivity === "safe" && entry.redaction !== "retain") ||
    (entry.sensitivity === "potentially-sensitive" &&
      entry.redaction === "retain")
  ) {
    throw new ExtensionRegistryError(
      "Extension redaction and sensitivity metadata are inconsistent",
    );
  }
  if (
    (entry.originTrust === "native-controlled" &&
      entry.sensitivity === "safe") ||
    (entry.contentClass === "location" && entry.redaction !== "path-policy") ||
    (entry.contentClass === "fixed-structural" &&
      (entry.originTrust !== "protocol-owned" ||
        entry.sensitivity !== "safe" ||
        entry.redaction !== "retain")) ||
    (entry.contentClass === "structured-metadata" &&
      (entry.originTrust !== "derived-metadata" ||
        entry.sensitivity !== "safe" ||
        entry.redaction !== "retain"))
  ) {
    throw new ExtensionRegistryError(
      "Extension content, origin, sensitivity, and route metadata are inconsistent",
    );
  }
  if (
    entry.openInferenceKinds?.some(
      (kind) =>
        !(Object.values(OpenInferenceSpanKind) as readonly string[]).includes(
          kind,
        ),
    ) === true
  ) {
    throw new ExtensionRegistryError(
      "Extension descriptor contains an unknown OpenInference kind",
    );
  }
  if (
    entry.introducedInProtocolContractVersion >
    standardsManifest.protocolContractVersion
  ) {
    throw new ExtensionRegistryError(
      "Extension descriptor introduction is newer than the standards manifest",
    );
  }
};

export const validateExtensionRegistry = (
  input: unknown,
): readonly AgentscopeExtensionDescriptor[] => {
  const registry = extensionRegistrySchema.parse(input);
  if (
    fingerprintExtensionEntries(registry.entries) !==
    registry.registryFingerprint
  ) {
    throw new ExtensionRegistryError(
      "Agentscope extension registry changed without an identity update",
    );
  }
  const duplicateKey = findDuplicate(registry.entries.map(({ key }) => key));
  if (duplicateKey !== undefined) {
    throw new ExtensionRegistryError(
      `Duplicate Agentscope extension key: ${duplicateKey}`,
    );
  }

  const duplicateSemantic = findDuplicate(
    registry.entries.map(({ semantic }) => semantic),
  );
  if (duplicateSemantic !== undefined) {
    throw new ExtensionRegistryError(
      `Duplicate Agentscope extension semantic: ${duplicateSemantic}`,
    );
  }

  registry.entries.forEach(validateDescriptorMetadata);

  const requiredEntries = new Map([
    ["agentscope.protocol.manifest_id", "resource"],
    ["agentscope.redaction.policy_id", "root-span"],
    ["agentscope.mapping.provenance", "span"],
  ]);
  for (const [key, applicability] of requiredEntries) {
    const entry = registry.entries.find((candidate) => candidate.key === key);
    if (
      entry?.requirementLevel !== "required" ||
      entry.applicability !== applicability
    ) {
      throw new ExtensionRegistryError(
        "Extension registry is missing a required protocol descriptor",
      );
    }
  }

  const expectedManifestId = `agentscope-protocol-${standardsManifest.protocolContractVersion}_${standardsManifest.upstreamBaselineId}_profile-${standardsManifest.canonicalProfile.profileVersion}-${standardsManifest.canonicalProfile.profileFingerprint}_identity-${standardsManifest.identityProfile.profileVersion}-${standardsManifest.identityProfile.profileFingerprint}_extensions-${registry.registryVersion}-${registry.registryFingerprint}_codec-${standardsManifest.codecProfile.profileVersion}-${standardsManifest.codecProfile.profileFingerprint}_compatibility-${standardsManifest.compatibilityProfile.profileVersion}-${standardsManifest.compatibilityProfile.profileFingerprint}`;
  if (standardsManifest.manifestId !== expectedManifestId) {
    throw new ExtensionRegistryError(
      "Protocol manifest identity does not bind the extension registry",
    );
  }

  return Object.freeze(
    registry.entries.map((entry) =>
      Object.freeze({
        ...entry,
        ...(entry.openInferenceKinds === undefined
          ? {}
          : {
              openInferenceKinds: Object.freeze([...entry.openInferenceKinds]),
            }),
      }),
    ),
  );
};

export const agentscopeExtensionRegistry = validateExtensionRegistry(
  standardsManifest.agentscopeExtensions,
);

const descriptorByKey = new Map(
  agentscopeExtensionRegistry.map((entry) => [entry.key, entry]),
);

export const getAgentscopeExtension = (
  key: string,
): AgentscopeExtensionDescriptor | undefined => descriptorByKey.get(key);
