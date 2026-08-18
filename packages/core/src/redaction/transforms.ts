import {
  REDACTION_TRANSFORMS,
  type RedactionOutcome,
  type RedactionTransform,
  type SemanticAttributeDescriptor,
  type StructuralSemanticDescriptor,
  type OpenInferenceSpanKindValue,
} from "@agentscope/protocol";

import {
  REDACTION_POLICY_PROFILE,
  redactionRuleOmits,
  type ResolvedRedactionPolicy,
} from "./policy.js";
export type { ResolvedRedactionPolicy } from "./policy.js";

export class CoreRedactionError extends Error {
  public readonly code = "core.redaction.suppressed";

  public constructor() {
    super("core.redaction.suppressed");
    this.name = "CoreRedactionError";
  }
}

type Descriptor = SemanticAttributeDescriptor | StructuralSemanticDescriptor;
type TransformState = {
  descriptor: Descriptor;
  value: unknown;
  parsedJson?: unknown;
  outcome?: RedactionOutcome;
  secret: boolean;
  absolutePath: boolean;
  uri?: URL;
  policy: ResolvedRedactionPolicy;
  replacement: string;
  transformed: boolean;
  oversized: boolean;
  userOmit: boolean;
};

const secretPatterns = REDACTION_POLICY_PROFILE.secretPatterns.map(
  (source) => new RegExp(source, REDACTION_POLICY_PROFILE.regexFlags.secret),
);
const secretKey = new RegExp(
  REDACTION_POLICY_PROFILE.secretKeyPattern,
  REDACTION_POLICY_PROFILE.regexFlags.secretKey,
);
const zeroWidth = new RegExp(
  REDACTION_POLICY_PROFILE.zeroWidthPattern,
  REDACTION_POLICY_PROFILE.regexFlags.zeroWidth,
);
const posixAbsolutePath = new RegExp(
  REDACTION_POLICY_PROFILE.pathPatterns.posix,
  REDACTION_POLICY_PROFILE.regexFlags.posixPath,
);
const tildePath = new RegExp(
  REDACTION_POLICY_PROFILE.pathPatterns.tilde,
  REDACTION_POLICY_PROFILE.regexFlags.tildePath,
);
const windowsAbsolutePath = new RegExp(
  REDACTION_POLICY_PROFILE.pathPatterns.windows,
  REDACTION_POLICY_PROFILE.regexFlags.windowsPath,
);
const fileUri = new RegExp(
  REDACTION_POLICY_PROFILE.pathPatterns.fileUri,
  REDACTION_POLICY_PROFILE.regexFlags.fileUri,
);
const sensitiveUriPath = new RegExp(
  REDACTION_POLICY_PROFILE.pathPatterns.sensitiveUri,
  REDACTION_POLICY_PROFILE.regexFlags.sensitiveUriPath,
);

const scanVariants = (value: string) => {
  /* v8 ignore next 2 -- the frozen profile has one implemented decode behavior. */
  if (
    REDACTION_POLICY_PROFILE.percentDecodeBehavior !==
    "fixed-point-stop-on-same-or-error"
  )
    throw new CoreRedactionError();
  const normalized = value
    .normalize(REDACTION_POLICY_PROFILE.normalization)
    .replace(zeroWidth, "");
  const variants = normalized === value ? [value] : [value, normalized];
  let candidate = normalized;
  for (
    let pass = 0;
    pass < REDACTION_POLICY_PROFILE.percentDecodePasses;
    pass += 1
  ) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      /* v8 ignore next -- fixed-point decoding cannot revisit an earlier value. */
      if (!variants.includes(decoded)) variants.push(decoded);
      candidate = decoded;
    } catch {
      // Malformed percent encoding is handled by the URI route when applicable.
      break;
    }
  }
  return variants;
};

const strings = (value: unknown, visit: (value: string) => void): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const member of value) strings(member, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      visit(key);
      strings((value as Record<string, unknown>)[key], visit);
    }
  }
};

const hasSecret = (value: unknown) => {
  let found = false;
  strings(value, (candidate) => {
    if (
      scanVariants(candidate).some(
        (variant) =>
          secretKey.test(variant) ||
          secretPatterns.some((pattern) => pattern.test(variant)),
      )
    )
      found = true;
  });
  return found;
};

const hasAbsolutePath = (value: unknown) => {
  let found = false;
  strings(value, (candidate) => {
    if (
      scanVariants(candidate).some(
        (variant) =>
          posixAbsolutePath.test(variant) ||
          tildePath.test(variant) ||
          windowsAbsolutePath.test(variant) ||
          fileUri.test(variant),
      )
    )
      found = true;
  });
  return found;
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1)
      output[index] = canonicalJsonValue(value[index]);
    return output;
  }
  if (typeof value !== "object" || value === null) return value;
  const output = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(value);
  for (let left = 0; left < keys.length; left += 1)
    for (let right = left + 1; right < keys.length; right += 1)
      if (keys[right]! < keys[left]!) {
        const swap = keys[left]!;
        keys[left] = keys[right]!;
        keys[right] = swap;
      }
  for (const key of keys)
    output[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
  return output;
};

const optionalOutcome = (state: TransformState): RedactionOutcome => {
  for (const outcome of REDACTION_POLICY_PROFILE.terminalSemantics
    .optionalOutcomePrecedence)
    if (state.descriptor.allowedOutcomes.includes(outcome)) return outcome;
  /* v8 ignore next -- the terminal profile includes the universal fallback. */
  throw new CoreRedactionError();
};

const parseUri = (value: string): URL => {
  /* v8 ignore next -- the frozen profile has one implemented URI parser. */
  if (REDACTION_POLICY_PROFILE.uriParser !== "whatwg-url")
    throw new CoreRedactionError();
  return new URL(value);
};

const serializeUri = (value: URL): string => {
  /* v8 ignore next -- the frozen profile has one implemented serializer. */
  if (REDACTION_POLICY_PROFILE.uriSerialization !== "whatwg-url-to-string")
    throw new CoreRedactionError();
  return value.toString();
};

type TerminalRoute =
  keyof typeof REDACTION_POLICY_PROFILE.terminalSemantics.routes;
type TerminalDecision = "retain" | "optional" | "suppress-trace";

const terminalOutcome = (
  route: TerminalRoute,
  state: TransformState,
): RedactionOutcome => {
  const semantics = REDACTION_POLICY_PROFILE.terminalSemantics;
  const rules = semantics.routes[route];
  const candidates: TerminalDecision[] = [rules.otherwise];
  if (state.policy.mode === "strict") candidates.push(rules.strict);
  if (state.userOmit) candidates.push("optional");
  if (state.secret) candidates.push(rules.secret);
  if (state.absolutePath) candidates.push(rules.absolutePath);
  if (state.oversized) candidates.push(rules.oversized);
  for (const decision of semantics.decisionPrecedence)
    if (candidates.includes(decision))
      return decision === "optional" ? optionalOutcome(state) : decision;
  /* v8 ignore next -- every exact route has an otherwise decision. */
  throw new CoreRedactionError();
};

type TransformHandler = (state: TransformState) => void;

export const TRANSFORM_HANDLERS = Object.freeze({
  bound(state) {
    const serialized =
      typeof state.value === "string"
        ? state.value
        : JSON.stringify(state.value);
    /* v8 ignore next -- supported capture candidate values always serialize. */
    if (serialized === undefined) throw new CoreRedactionError();
    state.oversized =
      serialized.length > REDACTION_POLICY_PROFILE.maximumRetainedCodeUnits;
  },
  "secret-scan"(state) {
    state.secret ||= hasSecret(state.value);
  },
  retain(state) {
    state.outcome = terminalOutcome("retain", state);
  },
  "absolute-path-scan"(state) {
    state.absolutePath ||= hasAbsolutePath(state.value);
  },
  "identifier-policy"(state) {
    state.outcome = terminalOutcome("identifier", state);
  },
  "path-policy"(state) {
    state.absolutePath ||= hasAbsolutePath(state.value);
    state.outcome = terminalOutcome("path", state);
  },
  "content-policy"(state) {
    state.outcome = terminalOutcome("content", state);
  },
  "parse-json"(state) {
    /* v8 ignore next -- descriptor validation precedes route execution. */
    if (typeof state.value !== "string") throw new CoreRedactionError();
    try {
      state.parsedJson = JSON.parse(state.value) as unknown;
    } catch {
      throw new CoreRedactionError();
    }
    if (
      state.descriptor.valueType === "json-object-string" &&
      (typeof state.parsedJson !== "object" ||
        state.parsedJson === null ||
        Array.isArray(state.parsedJson))
    )
      throw new CoreRedactionError();
  },
  "recursive-secret-scan"(state) {
    state.secret ||= hasSecret(state.value) || hasSecret(state.parsedJson);
  },
  "recursive-absolute-path-scan"(state) {
    state.absolutePath ||=
      hasAbsolutePath(state.value) || hasAbsolutePath(state.parsedJson);
  },
  "deterministic-json"(state) {
    const serialized = JSON.stringify(canonicalJsonValue(state.parsedJson));
    state.transformed ||= serialized !== state.value;
    state.value = serialized;
  },
  "reject-data-uri"(state) {
    if (typeof state.value !== "string" || /^data:/iu.test(state.value))
      state.outcome = optionalOutcome(state);
  },
  "reject-userinfo"(state) {
    if (state.outcome !== undefined) return;
    try {
      state.uri = parseUri(state.value as string);
    } catch {
      state.outcome = optionalOutcome(state);
      return;
    }
    if (state.uri.username !== "" || state.uri.password !== "")
      state.outcome = optionalOutcome(state);
  },
  "drop-query"(state) {
    if (state.uri !== undefined && state.uri.search !== "") {
      state.uri.search = "";
      state.value = serializeUri(state.uri);
      state.transformed = true;
    }
  },
  "drop-fragment"(state) {
    if (state.uri !== undefined && state.uri.hash !== "") {
      state.uri.hash = "";
      state.value = serializeUri(state.uri);
      state.transformed = true;
    }
  },
  "uri-policy"(state) {
    if (state.outcome !== undefined) return;
    /* v8 ignore next -- reject-userinfo establishes URI or an outcome. */
    if (state.uri === undefined) throw new CoreRedactionError();
    const isRepository =
      "key" in state.descriptor &&
      state.descriptor.key === "vcs.repository.url.full";
    const allowedProtocols = isRepository
      ? REDACTION_POLICY_PROFILE.uriProtocols.repository
      : REDACTION_POLICY_PROFILE.uriProtocols.media;
    if (
      !allowedProtocols.some((protocol) => protocol === state.uri!.protocol)
    ) {
      state.outcome = optionalOutcome(state);
      return;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(state.uri.pathname);
    } catch {
      state.outcome = optionalOutcome(state);
      return;
    }
    state.secret ||= hasSecret(
      `${state.uri.protocol}//${state.uri.hostname}${decodedPath}`,
    );
    state.absolutePath ||= scanVariants(decodedPath).some((variant) =>
      sensitiveUriPath.test(variant),
    );
    const repositorySuffix = new RegExp(
      REDACTION_POLICY_PROFILE.repositorySuffixPattern,
      REDACTION_POLICY_PROFILE.regexFlags.repositorySuffix,
    );
    if (isRepository && repositorySuffix.test(state.uri.pathname)) {
      state.uri.pathname = state.uri.pathname.replace(repositorySuffix, "");
      state.transformed = true;
    }
    state.value = serializeUri(state.uri);
    state.outcome = terminalOutcome("uri", state);
  },
  drop(state) {
    state.outcome = terminalOutcome("drop", state);
  },
} satisfies Record<RedactionTransform, TransformHandler>);

/* v8 ignore next 3 -- frozen startup inventory invariant. */
if (
  Object.keys(TRANSFORM_HANDLERS).length !== REDACTION_TRANSFORMS.length ||
  REDACTION_TRANSFORMS.some((name) => !(name in TRANSFORM_HANDLERS))
)
  throw new CoreRedactionError();

export type RedactionResult = Readonly<{
  outcome: RedactionOutcome;
  value?: unknown;
  transformed: boolean;
}>;

export const applyDescriptorRedaction = (
  descriptor: Descriptor,
  value: unknown,
  policy: ResolvedRedactionPolicy,
  replacement = REDACTION_POLICY_PROFILE.replacementLiteral,
  context: Readonly<{
    semanticKey?: string;
    spanKind?: OpenInferenceSpanKindValue;
  }> = {},
): RedactionResult => {
  try {
    const state: TransformState = {
      descriptor,
      value,
      secret: false,
      absolutePath: false,
      policy,
      replacement,
      transformed: false,
      oversized: false,
      userOmit:
        context.semanticKey === undefined
          ? false
          : redactionRuleOmits(
              policy,
              context.semanticKey,
              "templateId" in descriptor ? descriptor.templateId : undefined,
              context.spanKind,
            ),
    };
    for (const transform of descriptor.mandatoryTransforms)
      TRANSFORM_HANDLERS[transform as RedactionTransform](state);
    /* v8 ignore next -- exact route schemas always terminate with an outcome. */
    if (state.outcome === undefined) throw new CoreRedactionError();
    /* v8 ignore next 2 -- compiler cross-checks outcomes with descriptors. */
    if (!descriptor.allowedOutcomes.includes(state.outcome))
      throw new CoreRedactionError();
    if (state.outcome === "suppress-trace") throw new CoreRedactionError();
    return Object.freeze({
      outcome: state.outcome,
      ...(state.outcome === "retain"
        ? { value: state.value }
        : state.outcome === "replace-non-content"
          ? { value: state.replacement }
          : {}),
      transformed:
        state.outcome ===
          REDACTION_POLICY_PROFILE.terminalSemantics.replacementOutcome ||
        state.transformed ||
        !Object.is(state.value, value),
    });
  } catch {
    throw new CoreRedactionError();
  }
};
