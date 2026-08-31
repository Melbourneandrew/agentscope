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

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const entrypoint = join(repositoryRoot, "scripts/prepush.mjs");
const temporaryRoots = [];

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
  const joined = join(afterRoot, "pnpm.joined");
  executable(
    afterRoot,
    "git",
    `#!${process.execPath}\nprocess.stdout.write('GIT_DIR\\n')\n`,
  );
  executable(
    afterRoot,
    "pnpm",
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(joined)},'joined');process.exit(0)},50));setTimeout(()=>{},30000)\n`,
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
});

test("pre-push hook invokes only the scrubbed entrypoint", () => {
  assert.equal(
    readFileSync(join(repositoryRoot, ".husky/pre-push"), "utf8").trim(),
    "node scripts/prepush.mjs",
  );
});
