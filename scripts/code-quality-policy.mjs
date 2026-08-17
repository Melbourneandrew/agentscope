import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/u;
const testFile = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/u;
const moduleReference =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function sourceFiles(packageRoot) {
  return walk(join(packageRoot, "src")).filter(
    (path) => sourceExtension.test(path) && !testFile.test(path),
  );
}

function testFiles(packageRoot) {
  return walk(join(packageRoot, "src")).filter(
    (path) => sourceExtension.test(path) && testFile.test(path),
  );
}

function sourceLines(paths) {
  return paths.reduce((total, path) => {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("//");
      });
    return total + lines.length;
  }, 0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function internalDependencies(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  }).filter((name) => name.startsWith("@agentscope/"));
}

function assertAcyclic(graph) {
  const active = new Set();
  const visited = new Set();
  function visit(name, path) {
    if (active.has(name)) {
      throw new Error(
        `Workspace dependency cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...path, name]);
    }
    active.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
}

function entryFiles(packageRoot, manifest) {
  const targets = [];
  const collect = (value) => {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) collect(nested);
    }
  };
  collect(manifest.exports);
  collect(manifest.bin);
  return targets
    .filter((target) => target.includes("dist/"))
    .map((target) =>
      resolve(
        packageRoot,
        target.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts"),
      ),
    )
    .filter((path) => existsSync(path));
}

function resolveRelativeModule(from, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/u, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  return candidates.find((path) => existsSync(path));
}

function auditSourceGraph(packageRoot, files, entries) {
  const fileSet = new Set(files.map((path) => resolve(path)));
  const reachable = new Set();
  const active = new Set();
  const visit = (path) => {
    path = resolve(path);
    assert(
      !active.has(path),
      `Source module cycle: ${relative(packageRoot, path)}`,
    );
    if (reachable.has(path) || !fileSet.has(path)) return;
    active.add(path);
    reachable.add(path);
    const references = [
      ...readFileSync(path, "utf8").matchAll(moduleReference),
    ].map((match) => match[1]);
    for (const reference of references) {
      const target = resolveRelativeModule(path, reference);
      if (target) visit(target);
    }
    active.delete(path);
  };
  for (const entry of entries) visit(entry);
  const orphan = files.find((path) => !reachable.has(resolve(path)));
  assert(
    !orphan,
    `Dead production module is not reachable from a public entry: ${relative(packageRoot, orphan ?? "")}`,
  );
}

export function auditCoverageRatchet(current, baseline) {
  for (const [packagePath, currentPolicy] of Object.entries(current.packages)) {
    const previous = baseline.packages?.[packagePath];
    if (!previous?.coverage || !currentPolicy.coverage) continue;
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      assert(
        currentPolicy.coverage[metric] >= previous.coverage[metric],
        `${packagePath} coverage.${metric} may not decrease (${previous.coverage[metric]} -> ${currentPolicy.coverage[metric]})`,
      );
    }
  }
}

export function auditCodeQualityPolicy({
  workspaceRoot,
  expectedPackages,
  policy,
}) {
  const expectedPaths = [...expectedPackages.keys()].sort();
  assert(policy.version === 1, "quality-policy.json version must be 1");
  assert(
    JSON.stringify(Object.keys(policy.packages).sort()) ===
      JSON.stringify(expectedPaths),
    "quality-policy.json must declare exactly every workspace package",
  );

  const graph = new Map();
  for (const [packagePath, expectedName] of expectedPackages) {
    const packageRoot = resolve(workspaceRoot, packagePath);
    const manifest = readJson(join(packageRoot, "package.json"));
    const packagePolicy = policy.packages[packagePath];
    assert(packagePolicy.role, `${packagePath} must declare a package role`);
    assert(
      manifest.name === expectedName,
      `${packagePath} has an unexpected name`,
    );
    graph.set(expectedName, internalDependencies(manifest));

    const production = sourceFiles(packageRoot);
    const tests = testFiles(packageRoot);
    if (packagePolicy.unitTests === "required") {
      assert(
        tests.length > 0,
        `${packagePath} has production code but no unit tests`,
      );
      assert(
        packagePolicy.coverage,
        `${packagePath} must declare coverage thresholds`,
      );
      assert(
        !manifest.scripts.test.includes("passWithNoTests"),
        `${packagePath} may not pass with no tests`,
      );
    } else if (packagePolicy.unitTests === "marker-only") {
      assert(
        production.length <= packagePolicy.maxSourceFiles &&
          sourceLines(production) <= packagePolicy.maxSourceLines,
        `${packagePath} exceeded its marker-only allowance and must add real tests and coverage thresholds`,
      );
      assert(
        !packagePolicy.coverage,
        `${packagePath} marker-only packages may not publish cosmetic coverage thresholds`,
      );
    } else {
      assert(
        packagePolicy.unitTests === "not-applicable" &&
          typeof packagePolicy.reason === "string" &&
          packagePolicy.reason.length >= 40,
        `${packagePath} must have a specific reviewed unit-test exception`,
      );
    }

    if (packagePolicy.unitTests !== "not-applicable") {
      assert(
        manifest.scripts.test.includes("vitest run"),
        `${packagePath} unit tests must use Vitest`,
      );
      assert(
        manifest.scripts.coverage.includes("vitest run"),
        `${packagePath} coverage must use Vitest`,
      );
    }

    for (const path of [...production, ...tests]) {
      const contents = readFileSync(path, "utf8");
      assert(
        !contents.includes("node:test"),
        `${relative(workspaceRoot, path)} must use Vitest, not node:test`,
      );
      assert(
        !/@agentscope\/[\w-]+(?:\/[\w-]+)*\/src\//u.test(contents),
        `${relative(workspaceRoot, path)} imports another package's private source`,
      );
    }

    if (production.length > 0 && packagePolicy.unitTests !== "not-applicable") {
      auditSourceGraph(
        packageRoot,
        production,
        entryFiles(packageRoot, manifest),
      );
    }
  }
  assertAcyclic(graph);
  return { packageCount: expectedPackages.size };
}
