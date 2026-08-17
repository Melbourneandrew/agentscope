import type {
  NativeState,
  NativeIdentityKind,
  OpenInferenceSpanKindValue,
  ProvenanceSource,
  TimingBasis,
} from "@agentscope/protocol";

declare const capturedTraceBrand: unique symbol;
type CoreHarnessIdentitySource = Extract<
  ProvenanceSource,
  "harness-config" | "process"
>;

export const FIRST_PARTY_HARNESS_IDS = Object.freeze([
  "claude-code",
  "codex",
  "gemini-cli",
  "hermes",
  "openclaw",
  "opencode",
  "pi",
] as const);
export type HarnessRegistryId = (typeof FIRST_PARTY_HARNESS_IDS)[number];

export type SessionIdentityCandidate =
  | {
      readonly kind: "native-session";
      readonly nativeIdentityKind: NativeIdentityKind;
      readonly nativeIdentity: string;
    }
  | { readonly kind: "boundary-scoped" }
  | { readonly kind: "attempt-scoped" };

export type CaptureBoundaryCandidate = {
  readonly session: SessionIdentityCandidate;
  readonly boundaryKind:
    "hook-invocation" | "session" | "transcript-range" | "turn";
  readonly boundaryId: string;
  readonly generation: number;
  readonly positionKind: "byte-offset" | "event-index" | "line" | "sequence";
  readonly exclusiveEndPosition: number;
};

export type CapturedValueCandidate =
  | null
  | boolean
  | number
  | string
  | readonly CapturedValueCandidate[]
  | { readonly [key: string]: CapturedValueCandidate };

export type SemanticValueCandidate =
  boolean | number | string | readonly number[] | readonly string[];

export type OpenInferenceOperationKind = OpenInferenceSpanKindValue;

export type FieldProvenanceCandidate = {
  readonly field: string;
  readonly source: "hook-payload" | "native-artifact";
};

export type FieldUnavailableCandidate = FieldProvenanceCandidate & {
  readonly state: "unavailable" | "not-applicable" | "observed-empty";
  readonly reason:
    | "not-emitted"
    | "resolution-failed"
    | "unsupported"
    | "not-applicable"
    | "detached-head"
    | "empty-native-value";
};

export type SemanticFieldCandidate = {
  readonly field: string;
  readonly value: SemanticValueCandidate;
  readonly provenance: FieldProvenanceCandidate;
};

export type TimingCandidate = {
  readonly basis: Extract<TimingBasis, "native-interval" | "native-point">;
  readonly nativeState: Extract<NativeState, "observed">;
  readonly source: "hook-payload" | "native-artifact";
  readonly startUnixNano: string;
  readonly endUnixNano: string;
};

export type OperationLocatorCandidate =
  | { readonly kind: "native-operation"; readonly nativeId: string }
  | { readonly kind: "source-ordinal"; readonly ordinal: number };

export type EventCandidate = {
  readonly name: string;
  readonly nameProvenance: FieldProvenanceCandidate;
  readonly timeUnixNano: string;
  readonly timeProvenance: FieldProvenanceCandidate;
  readonly fields: readonly SemanticFieldCandidate[];
};

export type LinkTargetCandidate =
  | {
      readonly kind: "internal";
      readonly logicalOperationKey: string;
    }
  | {
      readonly kind: "external";
      readonly traceId: string;
      readonly spanId: string;
    };

export type LinkCandidate = {
  readonly target: LinkTargetCandidate;
  readonly targetProvenance: FieldProvenanceCandidate;
  readonly fields: readonly SemanticFieldCandidate[];
};

export type OperationCandidate = {
  readonly logicalKey: string;
  readonly locator: OperationLocatorCandidate;
  readonly parentLogicalKey?: string;
  readonly kind: OpenInferenceOperationKind;
  /** Core-owned construction intent for an operation carrying feedback fields. */
  readonly feedbackTransport?: "inline" | "post-hoc";
  readonly name: string;
  readonly nameProvenance: FieldProvenanceCandidate;
  readonly timing?: TimingCandidate;
  readonly fields: readonly SemanticFieldCandidate[];
  readonly unavailable: readonly FieldUnavailableCandidate[];
  readonly events: readonly EventCandidate[];
  readonly links: readonly LinkCandidate[];
};

export type RootContextCandidate = {
  readonly fields: readonly SemanticFieldCandidate[];
  readonly unavailable: readonly FieldUnavailableCandidate[];
};

export type CaptureSnapshotIdentity = {
  readonly configurationIdentity: string;
  readonly policyIdentity: string;
  readonly redactionPolicy: {
    readonly version: 1;
    readonly mode: "baseline" | "strict";
  };
};

export type CapturedTraceCandidate = {
  readonly captureBoundary: CaptureBoundaryCandidate;
  readonly rootContext: RootContextCandidate;
  readonly operations: readonly OperationCandidate[];
};

export type CapturedTraceSummary = {
  readonly type: "CapturedTrace";
  readonly state: "unredacted";
};

export interface CapturedTrace {
  readonly [capturedTraceBrand]: true;
  toJSON(): CapturedTraceSummary;
}

export interface HarnessCaptureFactory {
  capture(candidate: CapturedTraceCandidate): CapturedTrace;
}

export type CaptureInvocationContext = {
  readonly harnessRegistryId: HarnessRegistryId;
  readonly harnessVersion:
    | {
        readonly state: "observed";
        readonly value: string;
        readonly source: CoreHarnessIdentitySource;
      }
    | {
        readonly state: "unavailable";
        readonly reason: "not-emitted" | "resolution-failed" | "unsupported";
        readonly source: CoreHarnessIdentitySource;
      };
  readonly snapshot: CaptureSnapshotIdentity;
  readonly hookObservedUnixNano: string;
  readonly operationIdScope: "session-global" | "parent-scoped";
};
