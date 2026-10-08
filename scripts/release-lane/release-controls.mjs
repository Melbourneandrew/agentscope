import { parseAdmissionDocument } from "./admission.mjs";

const fail = () => {
  throw new Error("release.controls.unresolved");
};
const ownerId = 25971425;
const mainContexts = Object.freeze([
  "hermetic-integration",
  "Quality",
  "Unit tests",
  "Documentation",
  "Native candidate verification",
]);
const numeric = "(0|[1-9][0-9]*)";
const prerelease = "(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
export const semanticTagPattern = `^v${numeric}\\.${numeric}\\.${numeric}(-${prerelease}(\\.${prerelease})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$`;

// ADR-003 requires separate creation and immutable-ref rules. Tag-name metadata
// restrictions are Enterprise-organization features, not a personal-repository
// prerequisite. The release code separately binds the exact SemVer tag/version.

function tagScope(rule) {
  return (
    rule?.target === "tag" &&
    rule.enforcement === "active" &&
    rule.conditions?.ref_name?.include?.length === 1 &&
    rule.conditions.ref_name.include[0] === "refs/tags/v*" &&
    rule.conditions.ref_name.exclude?.length === 0
  );
}

export function validateTagRulesets(bytes) {
  const rulesets = parseAdmissionDocument(bytes);
  if (
    !Array.isArray(rulesets) ||
    rulesets.length !== 2 ||
    !rulesets.every(tagScope)
  )
    fail();
  const creation = rulesets.filter(
    (set) => set.rules?.length === 1 && set.rules[0].type === "creation",
  );
  const immutable = rulesets.filter(
    (set) =>
      set.rules?.length === 2 &&
      set.rules.filter((rule) => rule.type === "update").length === 1 &&
      set.rules.filter((rule) => rule.type === "deletion").length === 1,
  );
  if (
    creation.length !== 1 ||
    immutable.length !== 1 ||
    immutable[0].bypass_actors?.length !== 0 ||
    creation[0].bypass_actors?.length !== 1
  )
    fail();
  const actor = creation[0].bypass_actors[0];
  if (
    actor.actor_type !== "User" ||
    actor.actor_id !== ownerId ||
    actor.bypass_mode !== "always"
  )
    fail();
}

// Only fixed production API response bytes are inputs. Validation does not
// authenticate caller JSON: the acquisition boundary must use the fixed API.
export function validateImmutableReleaseResponse(bytes) {
  const value = parseAdmissionDocument(bytes);
  if (value?.enabled !== true) fail();
}

export function validateMainProtection(bytes) {
  const value = parseAdmissionDocument(bytes);
  if (
    value?.required_status_checks?.strict !== true ||
    value.enforce_admins?.enabled !== true ||
    value.allow_force_pushes?.enabled !== false ||
    value.allow_deletions?.enabled !== false ||
    !Array.isArray(value.required_status_checks.contexts) ||
    JSON.stringify([...value.required_status_checks.contexts].sort()) !==
      JSON.stringify([...mainContexts].sort()) ||
    !Array.isArray(value.required_status_checks.checks) ||
    value.required_status_checks.checks.length !== 5 ||
    !mainContexts.every(
      (context) =>
        value.required_status_checks.checks.filter(
          (check) => check.context === context && check.app_id === 15368,
        ).length === 1,
    )
  )
    fail();
}

export function validateReleaseEnvironment(bytes, policyBytes) {
  const value = parseAdmissionDocument(bytes);
  const policies = parseAdmissionDocument(policyBytes);
  const reviewers = value?.protection_rules?.filter(
    (rule) => rule.type === "required_reviewers",
  );
  if (
    value?.name !== "npm-release" ||
    reviewers?.length !== 1 ||
    reviewers[0].prevent_self_review !== false ||
    reviewers[0].reviewers?.length !== 1 ||
    reviewers[0].reviewers[0].type !== "User" ||
    reviewers[0].reviewers[0].reviewer?.id !== ownerId ||
    value.deployment_branch_policy?.protected_branches !== false ||
    value.deployment_branch_policy?.custom_branch_policies !== true ||
    policies?.total_count !== 2 ||
    !Array.isArray(policies.branch_policies) ||
    policies.branch_policies.length !== 2 ||
    !policies.branch_policies.some(
      (policy) => policy.name === "main" && policy.type === "branch",
    ) ||
    !policies.branch_policies.some(
      (policy) => policy.name === "v*" && policy.type === "tag",
    )
  )
    fail();
}

// The existing operator's authenticated gh session owns bounded acquisition;
// no administrative credential is exported into an Actions job. API summaries
// never substitute for full ruleset bodies, and the original deadline is shared.
export async function inspectReleaseControlsWithGet({ get, deadline }) {
  if (
    typeof get !== "function" ||
    !Number.isFinite(deadline) ||
    performance.now() >= deadline
  )
    fail();
  const summaries = parseAdmissionDocument(await get("/rulesets?per_page=100"));
  if (!Array.isArray(summaries) || summaries.length !== 2) fail();
  const ids = summaries.map((set) => set?.id);
  if (
    !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
    new Set(ids).size !== 2
  )
    fail();
  const rulesets = [];
  for (const id of ids) {
    const detail = parseAdmissionDocument(await get(`/rulesets/${id}`));
    if (
      detail?.id !== id ||
      detail.source !== "Melbourneandrew/agentscope" ||
      detail.source_type !== "Repository"
    )
      fail();
    rulesets.push(detail);
  }
  validateTagRulesets(Buffer.from(JSON.stringify(rulesets)));
  validateImmutableReleaseResponse(await get("/immutable-releases"));
  validateMainProtection(await get("/branches/main/protection"));
  const environment = await get("/environments/npm-release");
  const policies = await get(
    "/environments/npm-release/deployment-branch-policies?per_page=100",
  );
  validateReleaseEnvironment(environment, policies);
  if (performance.now() >= deadline) fail();
  return Object.freeze({
    state: "current-controls-observed",
    repository: "Melbourneandrew/agentscope",
  });
}
