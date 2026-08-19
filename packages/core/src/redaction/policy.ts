import { createHash } from "node:crypto";

import {
  OPENINFERENCE_SPAN_KINDS,
  semanticProfileDescriptors,
  type OpenInferenceSpanKindValue,
} from "@agentscope/protocol";
import { z } from "zod";

import { cloneConfigurationDocument } from "../configuration/plain-data.js";
import { BUILTIN_REDACTION_POLICY_REFERENCES } from "./policy-reference.js";

export { BUILTIN_REDACTION_POLICY_REFERENCES } from "./policy-reference.js";

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
};

const material = deepFreeze({
  version: 1,
  modes: ["baseline", "strict"],
  normalization: "NFKC",
  percentDecodePasses: 3,
  percentDecodeBehavior: "fixed-point-stop-on-same-or-error",
  maximumRetainedCodeUnits: 16_384,
  replacementLiteral: "redacted",
  regexFlags: {
    secret: "iu",
    secretKey: "iu",
    zeroWidth: "gu",
    posixPath: "u",
    tildePath: "u",
    windowsPath: "u",
    fileUri: "iu",
    sensitiveUriPath: "iu",
    repositorySuffix: "iu",
  },
  zeroWidthPattern: "[\\u200B-\\u200D\\u2060\\uFEFF]",
  secretPatterns: [
    "\\b(?:api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key)\\s*[:=]\\s*\\S+",
    "(?:^|[^A-Za-z\\d_-])(?:[A-Za-z][A-Za-z\\d_-]*)?(?:api[_-]?key|auth[_-]?token|session[_-]?token|github[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|password|token|secret|credential)\\s*[:=]\\s*\\S+",
    "\\bBearer\\s+\\S+",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bsk-[A-Za-z\\d_-]{12,}\\b",
    "\\beyJ[A-Za-z\\d_-]{8,}\\.[A-Za-z\\d_-]{8,}\\.[A-Za-z\\d_-]{8,}\\b",
    "-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----",
    "\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis):\\/\\/[^\\s/@:]+:[^\\s/@]+@",
    "\\b(?:[A-Z][A-Z\\d]*_)*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SECRET_ACCESS_KEY)\\s*=\\s*\\S+",
    "\\bgh[pousr]_[A-Za-z\\d]{20,}\\b",
    "\\bgithub_pat_[A-Za-z\\d_]{20,}\\b",
    "\\bglpat-[A-Za-z\\d_-]{20,}\\b",
    "\\bxox[baprs]-[A-Za-z\\d-]{10,}\\b",
    "\\bnpm_[A-Za-z\\d]{20,}\\b",
    "\\bsk_live_[A-Za-z\\d]{16,}\\b",
    "\\bAIza[A-Za-z\\d_-]{20,}\\b",
    "\\bhf_[A-Za-z\\d]{20,}\\b",
  ],
  secretKeyPattern:
    "^(?:(?:[a-z][a-z\\d]*[_-])*(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|secret[_-]?access[_-]?key)|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)$",
  pathPatterns: {
    posix: "(?:^\\/+(?=[^/\\s])|[^A-Za-z\\d_./-]\\/(?!\\/))[^\\s\"']+",
    tilde: "(?:^|[\\s\"'=:(])~[\\\\/][^\\s\"']+",
    windows:
      "(?:^|[^A-Za-z\\d_./-])(?:[A-Za-z]:[\\\\/]|\\\\\\\\(?:\\?\\\\|\\.\\\\)?[^\\\\/]+[\\\\/])",
    fileUri: "(?:^|[^A-Za-z\\d_./-])file:",
    sensitiveUri:
      "^\\/+\\s*(?:Users|home|private|var|tmp|etc|Volumes)(?:\\/|$)",
  },
  uriProtocols: {
    repository: ["http:", "https:"],
    media: ["https:", "s3:", "gs:"],
  },
  uriParser: "whatwg-url",
  uriSerialization: "whatwg-url-to-string",
  repositorySuffixPattern: "\\.git\\/?$",
  terminalSemantics: {
    decisionPrecedence: ["suppress-trace", "optional", "retain"],
    optionalOutcomePrecedence: [
      "omit-redacted",
      "omit-event",
      "replace-non-content",
      "suppress-trace",
    ],
    replacementOutcome: "replace-non-content",
    routes: {
      retain: {
        strict: "retain",
        secret: "suppress-trace",
        absolutePath: "suppress-trace",
        oversized: "suppress-trace",
        otherwise: "retain",
      },
      identifier: {
        strict: "optional",
        secret: "optional",
        absolutePath: "optional",
        oversized: "optional",
        otherwise: "retain",
      },
      path: {
        strict: "optional",
        secret: "optional",
        absolutePath: "optional",
        oversized: "optional",
        otherwise: "retain",
      },
      content: {
        strict: "optional",
        secret: "optional",
        absolutePath: "optional",
        oversized: "optional",
        otherwise: "retain",
      },
      uri: {
        strict: "optional",
        secret: "optional",
        absolutePath: "optional",
        oversized: "optional",
        otherwise: "retain",
      },
      drop: {
        strict: "optional",
        secret: "optional",
        absolutePath: "optional",
        oversized: "optional",
        otherwise: "optional",
      },
    },
  },
} as const);

export const REDACTION_POLICY_MATERIAL_FOR_TESTING = material;

export const fingerprintRedactionPolicyMaterialForTesting = (value: unknown) =>
  `sha256-${createHash("sha256").update(canonical(value)).digest("hex")}`;

export const REDACTION_POLICY_PROFILE_FINGERPRINT =
  fingerprintRedactionPolicyMaterialForTesting(material);

// Intentional migration guard: update only with reviewed policy semantics.
const EXPECTED_POLICY_FINGERPRINT =
  "sha256-0bd7538b7cffc7117cae907d238661611f01d262bf66d4ce18c9aeb146e2f11c";
/* v8 ignore next 2 -- startup migration guard exercised by the golden fingerprint. */
if (REDACTION_POLICY_PROFILE_FINGERPRINT !== EXPECTED_POLICY_FINGERPRINT)
  throw new Error("core.redaction.policy.invalid");

export const REDACTION_POLICY_PROFILE = deepFreeze({
  ...material,
  fingerprint: REDACTION_POLICY_PROFILE_FINGERPRINT,
});

export const REDACTION_POLICY_IDENTITIES = deepFreeze({
  baseline: `agentscope.redaction.baseline.v1.${REDACTION_POLICY_PROFILE_FINGERPRINT}`,
  strict: `agentscope.redaction.strict.v1.${REDACTION_POLICY_PROFILE_FINGERPRINT}`,
});

export const MAXIMUM_REDACTION_RULES = 64;
export const MAXIMUM_REDACTION_POLICY_BYTES = 32_768;
const referencePattern = /^[a-z0-9][a-z0-9._-]{0,255}$/u;
const selectorPattern = /^[a-z][a-z\d_.-]{0,255}$/u;
const selectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("semantic-key"),
    value: z.string().regex(selectorPattern),
  }),
  z.strictObject({
    kind: z.literal("template"),
    value: z.string().regex(selectorPattern),
  }),
]);
const ruleSchema = z.strictObject({
  selector: selectorSchema,
  spanKind: z.enum(OPENINFERENCE_SPAN_KINDS).optional(),
  action: z.literal("omit"),
});
const policySchema = z.strictObject({
  version: z.literal(1),
  reference: z.string().regex(referencePattern),
  mode: z.enum(["baseline", "strict"]),
  rules: z.array(ruleSchema).max(MAXIMUM_REDACTION_RULES),
});

export type RedactionPolicyRule = Readonly<{
  selector: Readonly<{
    kind: "semantic-key" | "template";
    value: string;
  }>;
  spanKind?: OpenInferenceSpanKindValue;
  action: "omit";
}>;

export type RedactionPolicyDefinition = Readonly<{
  version: 1;
  reference: string;
  mode: "baseline" | "strict";
  rules: readonly RedactionPolicyRule[];
}>;

export type ResolvedRedactionPolicy = Readonly<{
  version: 1;
  reference: string;
  mode: "baseline" | "strict";
  identity: string;
  rules: readonly RedactionPolicyRule[];
}>;

export type RedactionPolicyRegistry = Readonly<{
  readonly redactionPolicyRegistry: "agentscope-core";
}>;

export class RedactionPolicyError extends Error {
  public readonly code = "core.redaction.policy.invalid";

  public constructor() {
    super("core.redaction.policy.invalid");
    this.name = "RedactionPolicyError";
  }
}

const invalidPolicy = (): never => {
  throw new RedactionPolicyError();
};

const templateIds = new Set(
  semanticProfileDescriptors.attributes.flatMap(({ templateId }) =>
    templateId === undefined ? [] : [templateId],
  ),
);
const semanticKeys = new Set(
  semanticProfileDescriptors.attributes.flatMap(({ key }) =>
    key === undefined ? [] : [key],
  ),
);

const canonicalRule = (rule: RedactionPolicyRule) =>
  `${rule.selector.kind}:${rule.selector.value}:${rule.spanKind ?? "*"}:omit`;

const parsePolicy = (input: unknown): RedactionPolicyDefinition => {
  try {
    const cloned = cloneConfigurationDocument(input);
    if (
      Buffer.byteLength(JSON.stringify(cloned)) > MAXIMUM_REDACTION_POLICY_BYTES
    )
      return invalidPolicy();
    const parsed = policySchema.safeParse(cloned);
    if (!parsed.success) return invalidPolicy();
    const rules = parsed.data.rules.map((rule) => {
      const recognized =
        rule.selector.kind === "semantic-key"
          ? semanticKeys.has(rule.selector.value)
          : templateIds.has(rule.selector.value);
      if (!recognized) return invalidPolicy();
      return Object.freeze({
        selector: Object.freeze({ ...rule.selector }),
        ...(rule.spanKind === undefined ? {} : { spanKind: rule.spanKind }),
        action: "omit" as const,
      });
    });
    rules.sort((left, right) =>
      canonicalRule(left) < canonicalRule(right) ? -1 : 1,
    );
    if (new Set(rules.map(canonicalRule)).size !== rules.length)
      return invalidPolicy();
    return Object.freeze({
      version: 1 as const,
      reference: parsed.data.reference,
      mode: parsed.data.mode,
      rules: Object.freeze(rules),
    });
  } catch {
    return invalidPolicy();
  }
};

const policyRegistry = new WeakMap<
  RedactionPolicyRegistry,
  ReadonlyMap<string, RedactionPolicyDefinition>
>();

export const compileRedactionPolicyRegistry = (
  inputs: readonly unknown[],
): RedactionPolicyRegistry => {
  try {
    if (!Array.isArray(inputs) || inputs.length > 64) return invalidPolicy();
    const definitions = new Map<string, RedactionPolicyDefinition>();
    for (let index = 0; index < inputs.length; index += 1) {
      if (!Object.hasOwn(inputs, index)) return invalidPolicy();
      const definition = parsePolicy(inputs[index]);
      if (definitions.has(definition.reference)) return invalidPolicy();
      definitions.set(definition.reference, definition);
    }
    const registry = Object.freeze({
      redactionPolicyRegistry: "agentscope-core" as const,
    });
    policyRegistry.set(registry, definitions);
    return registry;
  } catch {
    return invalidPolicy();
  }
};

export const DEFAULT_REDACTION_POLICY_REGISTRY = compileRedactionPolicyRegistry(
  [
    {
      version: 1,
      reference: BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
      mode: "baseline",
      rules: [],
    },
    {
      version: 1,
      reference: BUILTIN_REDACTION_POLICY_REFERENCES.strict,
      mode: "strict",
      rules: [],
    },
  ],
);

const materializeResolvedPolicy = (
  definition: RedactionPolicyDefinition,
): ResolvedRedactionPolicy => {
  const definitionIdentity = createHash("sha256")
    .update(canonical(definition))
    .digest("hex");
  return Object.freeze({
    ...definition,
    identity: `agentscope.redaction.effective.v1.${definition.mode}.${REDACTION_POLICY_PROFILE_FINGERPRINT}.definition-${definitionIdentity}`,
  });
};

export const resolveRedactionPolicy = (
  registry: RedactionPolicyRegistry,
  reference: string,
): ResolvedRedactionPolicy => {
  try {
    const definition = policyRegistry.get(registry)?.get(reference);
    if (definition === undefined) return invalidPolicy();
    return materializeResolvedPolicy(definition);
  } catch {
    return invalidPolicy();
  }
};

export const validateResolvedRedactionPolicy = (
  value: unknown,
): ResolvedRedactionPolicy => {
  try {
    if (typeof value !== "object" || value === null) return invalidPolicy();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(descriptors).sort().join("\u0000") !==
      ["identity", "mode", "reference", "rules", "version"]
        .sort()
        .join("\u0000")
    )
      return invalidPolicy();
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        "get" in descriptor ||
        "set" in descriptor
      )
        return invalidPolicy();
      return descriptor.value as unknown;
    };
    const identity = read("identity");
    if (typeof identity !== "string") return invalidPolicy();
    const definition = parsePolicy({
      version: read("version"),
      reference: read("reference"),
      mode: read("mode"),
      rules: read("rules"),
    });
    const resolved = materializeResolvedPolicy(definition);
    return identity === resolved.identity ? resolved : invalidPolicy();
  } catch {
    return invalidPolicy();
  }
};

export const redactionRuleOmits = (
  policy: ResolvedRedactionPolicy,
  semanticKey: string,
  templateId: string | undefined,
  spanKind: OpenInferenceSpanKindValue | undefined,
): boolean =>
  policy.rules.some(
    (rule) =>
      (rule.spanKind === undefined || rule.spanKind === spanKind) &&
      (rule.selector.kind === "semantic-key"
        ? rule.selector.value === semanticKey
        : rule.selector.value === templateId),
  );
