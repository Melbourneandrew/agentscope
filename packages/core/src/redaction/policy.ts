import { createHash } from "node:crypto";

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
