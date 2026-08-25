import {
  assert,
  SHA256_PATTERN,
  SOURCE_REVISION_PATTERN,
} from "./validation.mjs";

export function validateReleaseWorkflowContext(context) {
  assert(
    context.repository === "Melbourneandrew/agentscope",
    "Unexpected workflow repository",
  );
  assert(
    SOURCE_REVISION_PATTERN.test(context.sourceRevision),
    "Invalid source revision",
  );
  assert(
    context.sourceRevision === context.observedHead &&
      context.sourceRevision === context.jobWorkflowSha,
    "Checkout, caller source, and reusable workflow SHA must be identical",
  );
  assert(
    /^Melbourneandrew\/agentscope\/\.github\/workflows\/release\.yml@refs\/(?:heads\/main|tags\/v0\.1\.0)$/u.test(
      context.callerWorkflowRef,
    ),
    "Untrusted caller workflow ref",
  );
  assert(
    /^Melbourneandrew\/agentscope\/\.github\/workflows\/release-candidate-rehearsal\.yml@refs\/(?:heads\/main|tags\/v0\.1\.0)$/u.test(
      context.jobWorkflowRef,
    ),
    "Untrusted reusable workflow ref",
  );
  assert(
    SHA256_PATTERN.test(context.expectedManifestDigest),
    "Invalid trusted candidate manifest digest",
  );
  assert(
    context.expectedProtectedTag === "v0.1.0",
    "Unexpected protected release tag",
  );
  return Object.freeze({
    callerWorkflowRef: context.callerWorkflowRef,
    jobWorkflowRef: context.jobWorkflowRef,
    sourceRevision: context.sourceRevision,
  });
}
