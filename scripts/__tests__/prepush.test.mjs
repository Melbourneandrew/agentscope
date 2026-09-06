import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import {
  parseLocalEnvironmentNames,
  scrubLocalEnvironment,
} from "../prepush.mjs";
import {
  createPrepushCommands,
  createPrepushPlan,
  executePrepush,
  parseAffectedProjects,
  parseChangedPaths,
  parseObjectId,
  parseProjectMetadata,
  selectPrepushMode,
} from "../prepush-affected.mjs";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const entrypoint = join(repositoryRoot, "scripts/prepush.mjs");
const temporaryRoots = [];

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const targets = Object.fromEntries(
  ["build", "lint", "test", "typecheck"].map((name) => [name, {}]),
);

function result(stdout, additions = {}) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    ...additions,
  };
}

function project(name, root) {
  return { name, root, targets };
}

function selectionFixture({
  paths = ["packages/core/src/index.ts"],
  projects = [project("@agentscope/core", "packages/core")],
  replace,
} = {}) {
  const calls = [];
  const captureCommand = (executable, arguments_) => {
    calls.push([executable, arguments_]);
    const index = calls.length - 1;
    if (replace?.index === index) return replace.value;
    if (index === 0) return result(`${BASE}\n`);
    if (index === 1) return result(`${HEAD}\n`);
    if (index === 2)
      return result(
        paths.length === 0
          ? Buffer.alloc(0)
          : Buffer.from(`${paths.join("\0")}\0`),
      );
    if (index === 3)
      return result(JSON.stringify(projects.map(({ name }) => name)));
    const expected = projects[index - 4];
    if (expected === undefined) throw new Error("unexpected capture");
    return result(JSON.stringify(expected));
  };
  return { calls, captureCommand };
}

test("selection observations are bounded, canonical, and duplicate-free", () => {
  assert.equal(parseObjectId(Buffer.from(`${BASE}\n`)), BASE);
  assert.deepEqual(
    parseChangedPaths(Buffer.from("docs/new name.md\0packages/core/a.ts\0")),
    ["docs/new name.md", "packages/core/a.ts"],
  );
  assert.deepEqual(
    parseAffectedProjects(Buffer.from('["agentscope-cli","@agentscope/core"]')),
    ["@agentscope/core", "agentscope-cli"],
  );
  assert.deepEqual(
    parseProjectMetadata(
      Buffer.from(JSON.stringify(project("@agentscope/core", "packages/core"))),
      "@agentscope/core",
    ),
    { name: "@agentscope/core", root: "packages/core" },
  );
  for (const invalid of [
    Buffer.from(`${BASE}`),
    Buffer.from(`${BASE}\n${HEAD}\n`),
    Buffer.from("not-an-object\n"),
  ])
    assert.throws(() => parseObjectId(invalid), /prepush-base-invalid/u);
  for (const invalid of [
    Buffer.from("unterminated"),
    Buffer.from("../escape\0"),
    Buffer.from("duplicate\0duplicate\0"),
    Buffer.from([0xff, 0]),
  ])
    assert.throws(() => parseChangedPaths(invalid), /prepush-paths-invalid/u);
  for (const invalid of [
    Buffer.from("{}"),
    Buffer.from('["duplicate","duplicate"]'),
    Buffer.from('["bad name"]'),
  ])
    assert.throws(
      () => parseAffectedProjects(invalid),
      /prepush-projects-invalid/u,
    );
  for (const invalid of [
    project("other", "packages/core"),
    project("@agentscope/core", "."),
    { name: "@agentscope/core", root: "packages/core", targets: {} },
  ])
    assert.throws(
      () =>
        parseProjectMetadata(
          Buffer.from(JSON.stringify(invalid)),
          "@agentscope/core",
        ),
      /prepush-project-invalid/u,
    );
});

test("one resolved base and head OID bind diff and every affected call", () => {
  const fixture = selectionFixture();
  const plan = createPrepushPlan({
    captureCommand: fixture.captureCommand,
    nxConfiguration: () => JSON.stringify({ defaultBase: "main" }),
  });
  assert.deepEqual(plan, {
    base: BASE,
    head: HEAD,
    mode: { full: false, policyChecks: false, verifyCliArtifact: false },
  });
  assert.deepEqual(fixture.calls.slice(0, 4), [
    ["git", ["rev-parse", "--verify", "main^{commit}"]],
    ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
    [
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${BASE}...${HEAD}`, "--"],
    ],
    [
      "pnpm",
      [
        "nx",
        "show",
        "projects",
        "--affected",
        `--base=${BASE}`,
        `--head=${HEAD}`,
        "--json",
      ],
    ],
  ]);
});

test("path coverage selects docs, packages, CLI closure, and conservative full", () => {
  const core = [{ name: "@agentscope/core", root: "packages/core" }];
  const docs = [{ name: "@agentscope/docs", root: "apps/docs" }];
  const sqliteCli = [
    {
      name: "@agentscope/destination-local-sqlite",
      root: "packages/destinations/local-sqlite",
    },
    { name: "agentscope-cli", root: "apps/cli" },
  ];
  for (const path of ["README.md", "ops/crabbox/README.md"])
    assert.deepEqual(selectPrepushMode([path], [], true), {
      full: false,
      policyChecks: false,
      verifyCliArtifact: false,
    });
  assert.deepEqual(
    selectPrepushMode(["apps/docs/content/docs/guide.mdx"], docs, true),
    { full: false, policyChecks: false, verifyCliArtifact: false },
  );
  assert.deepEqual(
    selectPrepushMode(["packages/core/src/index.ts"], core, true),
    { full: false, policyChecks: false, verifyCliArtifact: false },
  );
  for (const path of [
    "apps/cli/src/index.ts",
    "packages/destinations/local-sqlite/src/index.ts",
    "packages/destinations/local-sqlite/native-candidate/tooling/build.mjs",
  ])
    assert.deepEqual(selectPrepushMode([path], sqliteCli, true), {
      full: false,
      policyChecks: false,
      verifyCliArtifact: true,
    });
  for (const path of [
    "pnpm-lock.yaml",
    "package.json",
    "packages/core/package.json",
    "packages/new/nested/project.json",
    "packages/a/b/c/package.json",
    "nx.json",
    "scripts/verify-workspace-targets.mjs",
    ".github/workflows/validate.yml",
    "unknown/new-policy.bin",
    "README.mjs",
    "SECURITY.bin",
    "CONTRIBUTING.sh",
  ])
    assert.deepEqual(selectPrepushMode([path], [], true), {
      full: true,
      policyChecks: true,
      verifyCliArtifact: true,
    });
  assert.deepEqual(
    selectPrepushMode(
      ["README.md", "packages/core/src/index.ts"],
      [...core, { name: "agentscope-cli", root: "apps/cli" }],
      true,
    ),
    { full: false, policyChecks: false, verifyCliArtifact: true },
  );
});

test("an empty changed range remains a bounded Nx affected invocation", () => {
  const fixture = selectionFixture({ paths: [], projects: [] });
  const plan = createPrepushPlan({
    captureCommand: fixture.captureCommand,
    nxConfiguration: () => JSON.stringify({ defaultBase: "main" }),
  });
  assert.deepEqual(plan.mode, {
    full: false,
    policyChecks: false,
    verifyCliArtifact: false,
  });
  assert.equal(createPrepushCommands(plan)[2][1], "affected");
});

test("selection uncertainty falls back without using partial observations", () => {
  const failures = [
    result(`${BASE}\n${HEAD}\n`),
    result(`${BASE}\n`, { status: 1 }),
    result(Buffer.alloc(1024 * 1024 + 1)),
    result('["duplicate","duplicate"]'),
    result("{"),
    result(Buffer.alloc(1024 * 1024 + 1)),
    result(
      JSON.stringify({
        name: "@agentscope/core",
        root: "packages/core",
        targets: {},
      }),
    ),
  ];
  for (const [index, value] of failures.entries()) {
    const captureIndex = index < 3 ? index : index < 6 ? 3 : 4;
    const fixture = selectionFixture({
      replace: { index: captureIndex, value },
    });
    assert.deepEqual(
      createPrepushPlan({
        captureCommand: fixture.captureCommand,
        nxConfiguration: () => JSON.stringify({ defaultBase: "main" }),
      }),
      {
        mode: { full: true, policyChecks: true, verifyCliArtifact: true },
      },
    );
  }
  for (const nxConfiguration of [
    "{}",
    JSON.stringify({ defaultBase: "-hostile" }),
    JSON.stringify({ defaultBase: "main..other" }),
    JSON.stringify({ defaultBase: "HEAD" }),
  ]) {
    assert.equal(
      createPrepushPlan({
        captureCommand: () => {
          throw new Error("must not start selection");
        },
        nxConfiguration: () => nxConfiguration,
      }).mode.full,
      true,
    );
  }
});

test("affected and fallback command order never includes native or integration", () => {
  const affected = createPrepushCommands({
    base: BASE,
    head: HEAD,
    mode: { full: false, policyChecks: false, verifyCliArtifact: true },
  });
  assert.deepEqual(affected, [
    ["verify:targets"],
    ["format:check"],
    ["nx", "affected", "-t", "build", `--base=${BASE}`, `--head=${HEAD}`],
    [
      "nx",
      "affected",
      "-t",
      "lint,typecheck,test",
      `--base=${BASE}`,
      `--head=${HEAD}`,
    ],
    ["verify:cli-artifact"],
  ]);
  const fallback = createPrepushCommands({
    mode: { full: true, policyChecks: true, verifyCliArtifact: true },
  });
  assert.deepEqual(fallback, [
    ["verify:targets"],
    ["format:check"],
    ["test:workspace-policy"],
    ["verify:quality"],
    ["verify:acceptance-evidence"],
    ["nx", "run-many", "-t", "build", "--all"],
    ["nx", "run-many", "-t", "lint,typecheck,test", "--all"],
    ["verify:cli-artifact"],
  ]);
  assert.equal(JSON.stringify([affected, fallback]).includes("native"), false);
  assert.equal(
    JSON.stringify([affected, fallback]).includes("integration"),
    false,
  );
});

test("first command failure is exact and admits no later command", () => {
  const fixture = selectionFixture({
    paths: ["README.md"],
    projects: [],
  });
  const calls = [];
  const status = executePrepush({
    captureCommand: fixture.captureCommand,
    nxConfiguration: () => JSON.stringify({ defaultBase: "main" }),
    runCommand(arguments_) {
      calls.push(arguments_);
      return {
        error: undefined,
        signal: null,
        status: calls.length === 2 ? 31 : 0,
      };
    },
  });
  assert.equal(status, 31);
  assert.deepEqual(calls, [["verify:targets"], ["format:check"]]);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-prepush-test-"));
  temporaryRoots.push(root);
  return root;
}

function executable(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function environment(root, additions = {}) {
  return {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    ...additions,
  };
}

function run(root, additions = {}) {
  return spawnSync(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment(root, additions),
    timeout: 8_000,
  });
}

function git(cwd, ...arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: scrubLocalEnvironment(
      process.env,
      parseLocalEnvironmentNames(
        spawnSync("git", ["rev-parse", "--local-env-vars"], {
          encoding: "utf8",
        }).stdout,
      ),
    ),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("current Git local environment contract fits the closed parser", () => {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const names = parseLocalEnvironmentNames(result.stdout);
  assert.ok(names.length > 0);
  const ambient = Object.fromEntries(
    names.map((name, index) => [name, `HOSTILE-${index}`]),
  );
  ambient.UNRELATED_AUTHORITY = "preserved";
  const scrubbed = scrubLocalEnvironment(ambient, names);
  assert.deepEqual(
    names.filter((name) => Object.hasOwn(scrubbed, name)),
    [],
  );
  assert.equal(scrubbed.UNRELATED_AUTHORITY, "preserved");
});

test("parser rejects noncanonical, duplicate, and oversized contracts", () => {
  for (const value of [
    "",
    "GIT_DIR",
    "GIT_DIR\r\n",
    "GIT_DIR\nGIT_DIR\n",
    "1INVALID\n",
    `${"A".repeat(129)}\n`,
    `${Array.from({ length: 65 }, (_, index) => `LOCAL_${index}`).join("\n")}\n`,
    `${"A\n".repeat(4_097)}`,
  ]) {
    assert.throws(() => parseLocalEnvironmentNames(value));
  }
});

test("hook scrubs caller repository authority before exactly one prepush", () => {
  const root = temporaryRoot();
  const binaries = join(root, "bin");
  const caller = join(root, "caller");
  const fixture = join(root, "fixture");
  const marker = join(root, "calls.json");
  mkdirSync(binaries);
  mkdirSync(caller);
  mkdirSync(fixture);
  git(caller, "init", "--quiet");
  git(caller, "config", "user.email", "test@example.invalid");
  git(caller, "config", "user.name", "Hook Test");
  writeFileSync(join(caller, "caller.txt"), "caller\n");
  git(caller, "add", "caller.txt");
  git(caller, "commit", "--quiet", "-m", "caller");
  const callerHead = git(caller, "rev-parse", "HEAD");
  const callerIndex = readFileSync(join(caller, ".git/index"));

  executable(
    binaries,
    "git",
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'process.stdout.write("GIT_DIR\\nGIT_WORK_TREE\\nGIT_INDEX_FILE\\n")'\n`,
  );
  executable(
    binaries,
    "pnpm",
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({argv:process.argv.slice(2),gitDir:process.env.GIT_DIR,gitWorkTree:process.env.GIT_WORK_TREE,gitIndex:process.env.GIT_INDEX_FILE,unrelated:process.env.UNRELATED_AUTHORITY}));for(const args of [['init','--quiet'],['config','user.email','test@example.invalid'],['config','user.name','Fixture'],['add','fixture.txt'],['commit','--quiet','-m','fixture']]){if(args[0]==='add')fs.writeFileSync(path.join(${JSON.stringify(fixture)},'fixture.txt'),'fixture\\n');const result=spawnSync('/usr/bin/git',args,{cwd:${JSON.stringify(fixture)},stdio:'inherit'});if(result.status!==0)process.exit(result.status??74);}\n`,
  );
  const outcome = run(binaries, {
    GIT_DIR: join(caller, ".git"),
    GIT_WORK_TREE: caller,
    GIT_INDEX_FILE: join(caller, ".git/index"),
    UNRELATED_AUTHORITY: "preserved",
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
    argv: ["prepush"],
    unrelated: "preserved",
  });
  assert.equal(git(caller, "rev-parse", "HEAD"), callerHead);
  assert.deepEqual(readFileSync(join(caller, ".git/index")), callerIndex);
  assert.equal(git(caller, "status", "--short"), "");
  assert.match(git(fixture, "log", "-1", "--format=%s"), /^fixture$/u);
});

test("enumeration failures are content-free and never start pnpm", () => {
  for (const [name, source] of [
    ["nonzero", "process.stderr.write('SECRET');process.exit(29)"],
    ["malformed", "process.stdout.write('BAD-NAME\\n')"],
    ["oversize", "process.stdout.write('A'.repeat(9000))"],
    ["timeout", "setTimeout(()=>{},30000)"],
  ]) {
    const root = temporaryRoot();
    const marker = join(root, "pnpm-started");
    executable(root, "git", `#!${process.execPath}\n${source}\n`);
    executable(
      root,
      "pnpm",
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started')\n`,
    );
    const outcome = run(root, { SYNTHETIC_SECRET: name });
    assert.equal(outcome.status, 74, `${name}: ${outcome.stderr}`);
    assert.equal(outcome.stdout, "");
    assert.equal(outcome.stderr, "prepush: git-environment-unavailable\n");
    assert.throws(() => readFileSync(marker), /ENOENT/u);
  }
});

test("prepush exit status is propagated exactly", () => {
  const root = temporaryRoot();
  executable(
    root,
    "git",
    `#!${process.execPath}\nprocess.stdout.write('GIT_DIR\\n')\n`,
  );
  executable(root, "pnpm", `#!${process.execPath}\nprocess.exit(37)\n`);
  const outcome = run(root);
  assert.equal(outcome.status, 37, outcome.stderr);
});

test("signals prevent pre-spawn execution or forward and join prepush", async () => {
  const beforeRoot = temporaryRoot();
  const gitPid = join(beforeRoot, "git.pid");
  const pnpmMarker = join(beforeRoot, "pnpm-started");
  executable(
    beforeRoot,
    "git",
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(gitPid)},String(process.pid));setTimeout(()=>{},30000)\n`,
  );
  executable(
    beforeRoot,
    "pnpm",
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pnpmMarker)},'started')\n`,
  );
  const before = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    env: environment(beforeRoot),
    stdio: "ignore",
  });
  while (true) {
    try {
      readFileSync(gitPid);
      break;
    } catch {
      await new Promise((resolve_) => setTimeout(resolve_, 10));
    }
  }
  before.kill("SIGTERM");
  const beforeResult = await new Promise((resolve_) =>
    before.once("close", (code, signal) => resolve_({ code, signal })),
  );
  assert.deepEqual(beforeResult, { code: null, signal: "SIGTERM" });
  assert.throws(() => readFileSync(pnpmMarker), /ENOENT/u);

  const afterRoot = temporaryRoot();
  const childPid = join(afterRoot, "pnpm.pid");
  const descendantPid = join(afterRoot, "descendant.pid");
  const joined = join(afterRoot, "pnpm.joined");
  executable(
    afterRoot,
    "git",
    `#!${process.execPath}\nprocess.stdout.write('GIT_DIR\\n')\n`,
  );
  executable(
    afterRoot,
    "pnpm",
    `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');const descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});process.on('SIGTERM',()=>setTimeout(()=>{descendant.once('close',()=>{fs.writeFileSync(${JSON.stringify(joined)},'joined');process.exit(0)});descendant.kill('SIGTERM')},2250));fs.writeFileSync(${JSON.stringify(descendantPid)},String(descendant.pid));fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));setTimeout(()=>{},30000)\n`,
  );
  const after = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    env: environment(afterRoot),
    stdio: "ignore",
  });
  while (true) {
    try {
      readFileSync(childPid);
      break;
    } catch {
      await new Promise((resolve_) => setTimeout(resolve_, 10));
    }
  }
  after.kill("SIGTERM");
  const afterResult = await new Promise((resolve_) =>
    after.once("close", (code, signal) => resolve_({ code, signal })),
  );
  assert.deepEqual(afterResult, { code: null, signal: "SIGTERM" });
  assert.equal(readFileSync(joined, "utf8"), "joined");
  const escapedPid = Number(readFileSync(descendantPid, "utf8"));
  assert.throws(() => process.kill(escapedPid, 0), /ESRCH/u);
});

test("pre-push hook invokes only the scrubbed entrypoint", () => {
  assert.equal(
    readFileSync(join(repositoryRoot, ".husky/pre-push"), "utf8").trim(),
    "node scripts/prepush.mjs",
  );
});
