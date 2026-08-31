import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";

import { assert, assertExactKeys } from "./validation.mjs";

const forbiddenWorkflow = [
  /:\s*write\b/u,
  /id-token\s*:/u,
  /environment\s*:/u,
  /NPM_TOKEN/u,
  /NODE_AUTH_TOKEN/u,
  /npm\s+publish/u,
  /npm\s+stage/u,
  /\bgh\s+/u,
  /\bgit\s+(?!rev-parse\s+HEAD)/u,
  /curl\s/u,
  /wget\s/u,
];
const allowedActions = new Set([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
]);
const installCommand = "pnpm install --frozen-lockfile";
const substrateCommand = "pnpm verify:release-lane-substrate";
const workflowContextCommand =
  'node scripts/verify-release-workflow-context.mjs --repository "$GITHUB_REPOSITORY" --source-revision "$SOURCE_REVISION" --observed-head "$(git rev-parse HEAD)" --caller-workflow-ref "$CALLER_WORKFLOW_REF" --job-workflow-ref "$JOB_WORKFLOW_REF" --job-workflow-sha "$JOB_WORKFLOW_SHA" --candidate-manifest-digest "$EXPECTED_MANIFEST_DIGEST" --protected-tag v0.1.0';
const candidateCommand =
  'node scripts/verify-release-candidate.mjs --artifact-root artifacts/release-candidate --manifest-relative "$CANDIDATE_MANIFEST" --certification-relative "$CANDIDATE_CERTIFICATION" --tarball-relative "$CANDIDATE_TARBALL" --manifest-digest "$EXPECTED_MANIFEST_DIGEST" --source-revision "$EXPECTED_SOURCE_REVISION" --protected-tag v0.1.0';
const recordsCommand =
  'node scripts/verify-release-records.mjs --artifact-root artifacts/release-candidate --record-set-relative "$REHEARSAL_RECORDS" --candidate-manifest-relative "$CANDIDATE_MANIFEST" --trusted-candidate-manifest-digest "$EXPECTED_MANIFEST_DIGEST" --source-revision "$EXPECTED_SOURCE_REVISION" --protected-tag v0.1.0 --workspace-root . --workflow-relative .github/workflows/release.yml';
const allowedRunCommands = new Set([
  installCommand,
  substrateCommand,
  workflowContextCommand,
  candidateCommand,
  recordsCommand,
]);
const allowedRunEnvironment = new Set([
  "CALLER_WORKFLOW_REF",
  "CANDIDATE_CERTIFICATION",
  "CANDIDATE_MANIFEST",
  "CANDIDATE_TARBALL",
  "EXPECTED_MANIFEST_DIGEST",
  "EXPECTED_SOURCE_REVISION",
  "JOB_WORKFLOW_REF",
  "JOB_WORKFLOW_SHA",
  "REHEARSAL_RECORDS",
  "SOURCE_REVISION",
]);
const expectedWorkflowInputs = Object.freeze({
  "candidate-artifact-name": { required: true, type: "string" },
  "candidate-certification-path": { required: true, type: "string" },
  "candidate-manifest-path": { required: true, type: "string" },
  "candidate-tarball-path": { required: true, type: "string" },
  "rehearsal-records-path": { required: true, type: "string" },
  "trusted-candidate-manifest-digest": { required: true, type: "string" },
});
const expectedActionInputs = new Map([
  [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    {
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    },
  ],
  [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    {
      name: "${{ inputs.candidate-artifact-name }}",
      path: "artifacts/release-candidate",
    },
  ],
  [
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    { "node-version": 22, cache: "pnpm" },
  ],
  ["pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1", null],
]);
const expectedRunEnvironments = new Map([
  [installCommand, null],
  [substrateCommand, null],
  [
    workflowContextCommand,
    {
      EXPECTED_MANIFEST_DIGEST:
        "${{ inputs.trusted-candidate-manifest-digest }}",
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_WORKFLOW_REF: "${{ job.workflow_ref }}",
      JOB_WORKFLOW_SHA: "${{ job.workflow_sha }}",
      SOURCE_REVISION: "${{ github.sha }}",
    },
  ],
  [
    candidateCommand,
    {
      CANDIDATE_MANIFEST: "${{ inputs.candidate-manifest-path }}",
      CANDIDATE_CERTIFICATION: "${{ inputs.candidate-certification-path }}",
      CANDIDATE_TARBALL: "${{ inputs.candidate-tarball-path }}",
      EXPECTED_MANIFEST_DIGEST:
        "${{ inputs.trusted-candidate-manifest-digest }}",
      EXPECTED_SOURCE_REVISION: "${{ github.sha }}",
    },
  ],
  [
    recordsCommand,
    {
      CANDIDATE_MANIFEST: "${{ inputs.candidate-manifest-path }}",
      EXPECTED_MANIFEST_DIGEST:
        "${{ inputs.trusted-candidate-manifest-digest }}",
      EXPECTED_SOURCE_REVISION: "${{ github.sha }}",
      REHEARSAL_RECORDS: "${{ inputs.rehearsal-records-path }}",
    },
  ],
]);
const expectedStepTopology = Object.freeze([
  { uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262" },
  { uses: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1" },
  { uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020" },
  { run: installCommand },
  {
    uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  },
  { run: workflowContextCommand },
  { run: candidateCommand },
  { run: recordsCommand },
  { run: substrateCommand },
]);
export const releaseEntryPoints = Object.freeze([
  "scripts/verify-release-candidate.mjs",
  "scripts/verify-release-lane-policy.mjs",
  "scripts/verify-release-records.mjs",
  "scripts/verify-release-workflow-context.mjs",
]);
export const releaseAuthorityFiles = Object.freeze([
  ".github/workflows/release-candidate-rehearsal.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
const forbiddenScript = [/https?:\/\//u, /npm\s+(?:publish|stage)/u];
const allowedExternalModules = new Set([
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
  "node:zlib",
  "npm-package-arg",
  "typescript",
  "yaml",
]);

function assertAllowedModuleSpecifier(path, specifier) {
  if (specifier.startsWith(".")) return;
  assert(
    allowedExternalModules.has(specifier),
    `Release script ${path} contains forbidden network/process authority: non-allowlisted external module ${specifier}`,
  );
}

function contained(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, path);
  assert(
    absolute.startsWith(`${absoluteRoot}${sep}`),
    `Policy path escapes: ${path}`,
  );
  return absolute;
}

function assertAllowedKeys(value, allowed, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  for (const key of Object.keys(value))
    assert(
      allowed.includes(key),
      `${label} contains forbidden authority: ${key}`,
    );
}

function assertExactObject(value, expected, label) {
  assertExactKeys(value, Object.keys(expected), label);
  const sortedEntries = (subject) =>
    Object.entries(subject).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  assert(
    JSON.stringify(sortedEntries(value)) ===
      JSON.stringify(sortedEntries(expected)),
    `${label} values drifted`,
  );
}

function normalizeRun(run) {
  return run.trim().replace(/\s+/gu, " ");
}

function validateActionStep(step) {
  assertAllowedKeys(step, ["name", "uses", "with"], "release action step");
  assert(
    allowedActions.has(step.uses),
    `Release workflow action is not exact-SHA allowlisted: ${step.uses}`,
  );
  const expectedWith = expectedActionInputs.get(step.uses);
  if (expectedWith === null) {
    assert(step.with === undefined, "Release action inputs drifted");
    return;
  }
  assertExactObject(step.with, expectedWith, "release action inputs");
}

function validateRunStep(step) {
  assertAllowedKeys(step, ["env", "name", "run"], "release run step");
  const command = typeof step.run === "string" ? normalizeRun(step.run) : "";
  assert(
    allowedRunCommands.has(command),
    "Release workflow run command is not exact allowlisted",
  );
  const expectedEnvironment = expectedRunEnvironments.get(command);
  if (expectedEnvironment === null) {
    assert(step.env === undefined, "Release run environment drifted");
    return;
  }
  assertAllowedKeys(
    step.env,
    [...allowedRunEnvironment],
    "release run environment",
  );
  assertExactObject(step.env, expectedEnvironment, "release run environment");
}

function validateWorkflowShape(workflow) {
  const document = parseDocument(workflow, { uniqueKeys: true });
  assert(
    document.errors.length === 0,
    `Release workflow YAML is invalid: ${document.errors[0]?.message ?? "unknown"}`,
  );
  const parsed = document.toJS();
  assertExactKeys(
    parsed,
    ["jobs", "name", "on", "permissions"],
    "release workflow",
  );
  assertExactKeys(parsed.on, ["workflow_call"], "release workflow triggers");
  assertExactKeys(parsed.on.workflow_call, ["inputs"], "release workflow_call");
  assertExactKeys(
    parsed.on.workflow_call.inputs,
    Object.keys(expectedWorkflowInputs),
    "release workflow inputs",
  );
  for (const [name, observed] of Object.entries(
    parsed.on.workflow_call.inputs,
  )) {
    const expected = Object.entries(expectedWorkflowInputs)
      .find(([expectedName]) => expectedName === name)
      ?.at(1);
    assert(expected !== undefined, `Unexpected release workflow input ${name}`);
    assertExactObject(observed, expected, `release workflow input ${name}`);
  }
  assertExactObject(
    parsed.permissions,
    { contents: "read" },
    "release permissions",
  );
  assertExactKeys(
    parsed.jobs,
    ["validate-certified-candidate"],
    "release workflow jobs",
  );
  const job = parsed.jobs["validate-certified-candidate"];
  assertExactKeys(
    job,
    ["name", "runs-on", "steps", "timeout-minutes"],
    "release validation job",
  );
  assert(
    job["runs-on"] === "ubuntu-latest" &&
      job["timeout-minutes"] === 15 &&
      Array.isArray(job.steps),
    "Release validation job authority drifted",
  );
  assert(
    job.steps.length === expectedStepTopology.length,
    "Release workflow step topology length drifted",
  );
  for (const [index, step] of job.steps.entries()) {
    const expectedStep = expectedStepTopology.at(index);
    const hasUses = Object.hasOwn(step, "uses");
    const hasRun = Object.hasOwn(step, "run");
    assert(
      hasUses !== hasRun,
      "Release step must select exactly one authority",
    );
    if (hasUses) {
      assert(
        expectedStep?.uses === step.uses,
        `Release workflow action topology drifted at step ${index}`,
      );
      validateActionStep(step);
    } else {
      assert(
        expectedStep?.run === normalizeRun(step.run),
        `Release workflow run topology drifted at step ${index}`,
      );
      validateRunStep(step);
    }
  }
}

const forbiddenAmbientIdentifiers = new Set([
  "eval",
  "Function",
  "global",
  "globalThis",
  "Reflect",
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
]);

function assertNoAmbientCodeGeneration(path, node) {
  const forbiddenProperties = [
    "constructor",
    "__proto__",
    "getPrototypeOf",
    "getOwnPropertyDescriptor",
  ];
  const constantString = (expression) => {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = constantString(expression.left);
      const right = constantString(expression.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  };
  const forbiddenIdentifier =
    ts.isIdentifier(node) && forbiddenAmbientIdentifiers.has(node.text);
  const forbiddenProperty =
    ts.isPropertyAccessExpression(node) &&
    forbiddenProperties.includes(node.name.text);
  const forbiddenElement =
    ts.isElementAccessExpression(node) &&
    (forbiddenProperties.includes(constantString(node.argumentExpression)) ||
      (ts.isIdentifier(node.expression) && node.expression.text === "Object"));
  const bindingProperty = ts.isBindingElement(node)
    ? (node.propertyName ?? node.name)
    : undefined;
  const forbiddenBinding =
    bindingProperty !== undefined &&
    (ts.isIdentifier(bindingProperty) || ts.isStringLiteral(bindingProperty)
      ? forbiddenProperties.includes(bindingProperty.text)
      : ts.isComputedPropertyName(bindingProperty));
  const assignmentProperty =
    ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
      ? node.name
      : undefined;
  const forbiddenAssignment =
    assignmentProperty !== undefined &&
    (ts.isIdentifier(assignmentProperty) ||
    ts.isStringLiteral(assignmentProperty)
      ? forbiddenProperties.includes(assignmentProperty.text)
      : ts.isComputedPropertyName(assignmentProperty));
  const forbiddenDynamicElement =
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteral(node.argumentExpression) &&
    !ts.isNumericLiteral(node.argumentExpression);
  if (
    forbiddenIdentifier ||
    forbiddenProperty ||
    forbiddenElement ||
    forbiddenBinding ||
    forbiddenAssignment ||
    forbiddenDynamicElement
  )
    throw new Error(
      `Release script ${path} contains forbidden runtime code-generation authority`,
    );
}

function assertNoAmbientNetworkOrLoader(path, node, parent) {
  const forbiddenCall =
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ["require", "createRequire"].includes(node.expression.text);
  const property = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  const forbiddenFetch = ts.isIdentifier(node) && node.text === "fetch";
  const allowedProcessIdentifier =
    ts.isIdentifier(node) &&
    node.text === "process" &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    ["argv", "stdout"].includes(parent.name.text);
  const forbiddenProcessIdentifier =
    ts.isIdentifier(node) &&
    node.text === "process" &&
    !allowedProcessIdentifier;
  if (
    forbiddenCall ||
    forbiddenFetch ||
    forbiddenProcessIdentifier ||
    ["getBuiltinModule", "fetch"].includes(property)
  )
    throw new Error(
      `Release script ${path} contains forbidden network/process authority`,
    );
  const processAccess =
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process";
  const allowedProcessAccess =
    ts.isPropertyAccessExpression(node) &&
    ["argv", "stdout"].includes(node.name.text);
  if (processAccess && !allowedProcessAccess)
    throw new Error(
      `Release script ${path} contains forbidden process authority`,
    );
}

function localModuleSpecifiers(path, script) {
  const parsed = ts.createSourceFile(
    path,
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = [];
  const visit = (node, parent) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      assert(
        ts.isStringLiteral(node.moduleSpecifier),
        `Release script contains an unbounded module specifier: ${path}`,
      );
      assertAllowedModuleSpecifier(path, node.moduleSpecifier.text);
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      assert(
        node.arguments.length === 1 &&
          (ts.isStringLiteral(node.arguments[0]) ||
            ts.isNoSubstitutionTemplateLiteral(node.arguments[0])),
        `Release script contains an unbounded dynamic import: ${path}`,
      );
      assertAllowedModuleSpecifier(path, node.arguments[0].text);
      specifiers.push(node.arguments[0].text);
    } else {
      assertNoAmbientCodeGeneration(path, node);
      assertNoAmbientNetworkOrLoader(path, node, parent);
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(parsed);
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

export function collectReleaseScriptBytes(workspaceRoot, scriptPaths) {
  const pending = [...scriptPaths];
  const observed = new Map();
  while (pending.length > 0) {
    const path = pending.pop();
    if (observed.has(path)) continue;
    const absolute = contained(workspaceRoot, path);
    const script = readFileSync(absolute, "utf8");
    observed.set(path, script);
    for (const specifier of localModuleSpecifiers(path, script)) {
      const imported = resolve(dirname(absolute), specifier);
      const importedRelative = relative(resolve(workspaceRoot), imported);
      assert(
        importedRelative.endsWith(".mjs"),
        `Release script imports an unbounded local module: ${specifier}`,
      );
      pending.push(importedRelative);
    }
  }
  return observed;
}

export function collectReleaseAuthorityBytes(
  workspaceRoot,
  {
    entryPoints = releaseEntryPoints,
    authorityFiles = releaseAuthorityFiles,
  } = {},
) {
  const observed = collectReleaseScriptBytes(workspaceRoot, entryPoints);
  for (const path of authorityFiles)
    observed.set(path, readFileSync(contained(workspaceRoot, path)));
  return Object.fromEntries(
    [...observed.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function validateOfflineReleasePolicy({
  workspaceRoot,
  workflowPath,
  scriptPaths,
}) {
  const workflow = readFileSync(contained(workspaceRoot, workflowPath), "utf8");
  validateWorkflowShape(workflow);
  for (const pattern of forbiddenWorkflow) {
    assert(
      !pattern.test(workflow),
      `Release workflow contains forbidden authority: ${pattern}`,
    );
  }
  assert(
    !workflow.includes("@agentscope/core"),
    "Stale private publisher identity remains",
  );
  const scripts = collectReleaseScriptBytes(workspaceRoot, scriptPaths);
  for (const [path, script] of scripts) {
    for (const pattern of forbiddenScript) {
      assert(
        !pattern.test(script),
        `Release script ${path} contains forbidden network/process authority`,
      );
    }
  }
  return Object.freeze({ scripts: scripts.size, workflow: workflowPath });
}
