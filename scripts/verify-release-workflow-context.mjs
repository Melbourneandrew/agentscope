import { validateReleaseWorkflowContext } from "./release-lane/workflow-context.mjs";

const value = (name) => {
  const index = process.argv.indexOf(name);
  const result = process.argv.at(index + 1);
  if (index < 0 || !result) throw new Error(`Missing ${name}`);
  return result;
};

const repository = value("--repository");
const sourceRevision = value("--source-revision");
const observedHead = value("--observed-head");
const callerWorkflowRef = value("--caller-workflow-ref");
const jobWorkflowRef = value("--job-workflow-ref");
const jobWorkflowSha = value("--job-workflow-sha");
const expectedManifestDigest = value("--candidate-manifest-digest");
const expectedProtectedTag = value("--protected-tag");

const result = validateReleaseWorkflowContext({
  repository,
  sourceRevision,
  observedHead,
  callerWorkflowRef,
  jobWorkflowRef,
  jobWorkflowSha,
  expectedManifestDigest,
  expectedProtectedTag,
});

process.stdout.write(
  `Verified exact nonpublishing workflow context: ${JSON.stringify(result)}\n`,
);
