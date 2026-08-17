import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// AC-INS-001.1 AC-INS-001.2 AC-INS-001.3 AC-INS-001.4 AC-INS-003.2
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const artifactDirectory = resolve(repositoryRoot, "artifacts/npm");
const stagingRoot = resolve(repositoryRoot, "artifacts/staging/cli");
const installRoot = mkdtempSync(join(tmpdir(), "agentscope-cli-install-"));
const isolatedHome = join(installRoot, "home");
const npmUserConfig = join(installRoot, "empty-npmrc");
mkdirSync(artifactDirectory, { recursive: true });
mkdirSync(isolatedHome);
writeFileSync(npmUserConfig, "");

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      npm_config_cache: join(installRoot, "npm-cache"),
      npm_config_userconfig: npmUserConfig,
    },
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${arguments_.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result;
}

run(process.execPath, [resolve(packageRoot, "build.mjs")]);
rmSync(stagingRoot, { force: true, recursive: true });
mkdirSync(stagingRoot, { recursive: true });
cpSync(resolve(packageRoot, "dist"), resolve(stagingRoot, "dist"), {
  recursive: true,
});
const developmentManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const publishManifest = Object.fromEntries(
  [
    "name",
    "version",
    "description",
    "license",
    "type",
    "engines",
    "bin",
    "files",
    "publishConfig",
  ].map((field) => [field, developmentManifest[field]]),
);
writeFileSync(
  resolve(stagingRoot, "package.json"),
  `${JSON.stringify(publishManifest, undefined, 2)}\n`,
);
const packResult = run("npm", [
  "pack",
  stagingRoot,
  "--json",
  "--ignore-scripts",
  "--pack-destination",
  artifactDirectory,
]);
const packReport = JSON.parse(packResult.stdout);
assert.equal(packReport.length, 1);
const tarball = join(artifactDirectory, packReport[0].filename);
assert.ok(existsSync(tarball));

run(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    tarball,
  ],
  { cwd: installRoot },
);

const installedPackage = join(
  installRoot,
  "node_modules/@agentscope/cli/package.json",
);
const installedManifest = JSON.parse(readFileSync(installedPackage, "utf8"));
for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  assert.deepEqual(installedManifest[field] ?? {}, {});
}
assert.equal(installedManifest.devDependencies, undefined);
assert.equal(installedManifest.scripts, undefined);

const executable = join(installRoot, "node_modules/.bin/agentscope");
if (process.platform !== "win32") chmodSync(executable, 0o755);
const help = run(executable, ["--help"], { cwd: installRoot });
assert.match(help.stdout, /^Usage: agentscope \[options\]/u);
assert.equal(help.stderr, "");
const version = run(executable, ["--version"], { cwd: installRoot });
assert.equal(version.stdout, `${installedManifest.version}\n`);
assert.equal(version.stderr, "");

const bundle = readFileSync(
  join(installRoot, "node_modules/@agentscope/cli/dist/bin/agentscope.js"),
  "utf8",
);
assert.doesNotMatch(bundle, /workspace:/u);
assert.doesNotMatch(bundle, /from\s+["']@agentscope\//u);
assert.doesNotMatch(bundle, /require\(["']@agentscope\//u);
assert.deepEqual(readdirSync(join(installRoot, "node_modules/@agentscope")), [
  "cli",
]);

process.stdout.write(
  `Verified clean install of ${basename(tarball)} (${packReport[0].integrity})\n`,
);
rmSync(installRoot, { force: true, recursive: true });
