export const agentscope = {
  framework: "agentscope",
  purpose: "agent-trace-observability",
} as const;

export { withCaptureInvocation } from "./capture/runtime.js";
export {
  CoreRedactionError,
  redactCapturedTrace,
} from "./redaction/pipeline.js";
export {
  REDACTION_POLICY_IDENTITIES,
  REDACTION_POLICY_PROFILE,
  REDACTION_POLICY_PROFILE_FINGERPRINT,
} from "./redaction/policy.js";
export {
  runFailOpenTraceLifecycle,
  type CaptureAdapter,
  type LifecycleFailureReason,
  type LifecycleResult,
  type LifecycleStage,
  type TraceLifecycleInput,
} from "./lifecycle.js";
