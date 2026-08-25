import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

import { assert } from "./validation.mjs";

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
const forbiddenScript = [
  /node:(?:child_process|http|https|net|tls|dns|dgram)/u,
  /\bfetch\s*\(/u,
  /https?:\/\//u,
  /npm\s+(?:publish|stage)/u,
];
const forbiddenBuiltins = new Set([
  "child_process",
  "dgram",
  "dns",
  "http",
  "https",
  "module",
  "net",
  "tls",
  "vm",
  "worker_threads",
]);

function assertAllowedModuleSpecifier(path, specifier) {
  assert(
    !forbiddenBuiltins.has(specifier.replace(/^node:/u, "")),
    `Release script ${path} contains forbidden network/process authority`,
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

function validateWorkflowShape(workflow) {
  const onStart = workflow.indexOf("on:\n");
  const permissionsStart = workflow.indexOf("permissions:\n");
  assert(
    onStart >= 0 && permissionsStart > onStart,
    "Release workflow trigger block is malformed",
  );
  const triggerBlock = workflow.slice(onStart + 3, permissionsStart);
  const triggerKeys = [
    ...triggerBlock.matchAll(/^ {2}([a-zA-Z0-9_-]+):/gmu),
  ].map((match) => match[1]);
  assert(
    JSON.stringify(triggerKeys) === JSON.stringify(["workflow_call"]),
    `Release substrate has non-reusable triggers: ${triggerKeys.join(",")}`,
  );
  const actions = [
    ...workflow.matchAll(
      /^\s+(?:-\s+)?(?:uses|"uses"|'uses')\s*:\s*(\S+)\s*$/gmu,
    ),
  ].map((match) => match[1]);
  const usesKeys = workflow.match(/(?:uses|"uses"|'uses')\s*:/gu) ?? [];
  assert(
    actions.length === usesKeys.length,
    "Release workflow contains an unparsed action mapping",
  );
  for (const action of actions)
    assert(
      allowedActions.has(action),
      `Release workflow action is not exact-SHA allowlisted: ${action}`,
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
  const visit = (node) => {
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
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["require", "createRequire"].includes(node.expression.text)
    ) {
      throw new Error(
        `Release script ${path} contains forbidden network/process authority`,
      );
    } else if (
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "getBuiltinModule") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "getBuiltinModule")
    ) {
      throw new Error(
        `Release script ${path} contains forbidden network/process authority`,
      );
    }
    ts.forEachChild(node, visit);
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
  assert(
    /^permissions:\n {2}contents: read$/mu.test(workflow),
    "Release workflow lacks exact read-only permissions",
  );
  assert(
    /^ {2}workflow_call:$/mu.test(workflow),
    "Release substrate must be reusable-only",
  );
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
