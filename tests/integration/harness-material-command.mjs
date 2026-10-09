import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const execute = promisify(execFile);
const maximumOutputBytes = 8 * 1024 * 1024;
let verificationStage = "entry";
const fail = () => {
  throw new Error("integration.harness-material-command.failed");
};
const record = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail();
  return value;
};
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > maximumOutputBytes) fail();
  return record(JSON.parse(bytes.toString("utf8")));
};
const npmEnvironment = (home, registry) => ({
  HOME: home,
  LANG: "C.UTF-8",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_CACHE: resolve(home, "cache"),
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_GLOBALCONFIG: resolve(home, "global.npmrc"),
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
  NPM_CONFIG_REGISTRY: registry,
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_USERCONFIG: resolve(home, "user.npmrc"),
  PATH: "/usr/local/bin:/usr/bin:/bin",
});
const gpgArguments = (home) => [
  "--batch",
  "--no-options",
  "--no-autostart",
  "--no-auto-key-retrieve",
  "--auto-key-locate",
  "clear",
  "--homedir",
  home,
];

const verifyNpm = async (root, policy) => {
  verificationStage = "npm-input";
  const packages = Array.isArray(policy.packages) ? policy.packages : fail();
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({
      dependencies: Object.fromEntries(
        packages.map((entry) => [
          entry.installName,
          entry.installName === entry.packageName
            ? entry.version
            : `npm:${entry.packageName}@${entry.version}`,
        ]),
      ),
      name: "agentscope-material-verifier",
      private: true,
      version: "1.0.0",
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const environment = npmEnvironment(resolve(root, "home"), policy.registry);
  const npm = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
  verificationStage = "npm-version";
  const { stdout: npmVersion } = await execute(
    "/usr/local/bin/node",
    [npm, "--version"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: maximumOutputBytes,
    },
  );
  if (npmVersion !== `${policy.verifierNpmVersion}\n`) fail();
  verificationStage = "npm-install";
  await execute(
    "/usr/local/bin/node",
    [
      npm,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `--registry=${policy.registry}`,
    ],
    { cwd: root, env: environment, maxBuffer: maximumOutputBytes },
  );
  verificationStage = "npm-lock";
  const lock = readJson(resolve(root, "package-lock.json"));
  for (const entry of packages) {
    const installed = record(
      lock.packages?.[`node_modules/${entry.installName}`],
    );
    if (
      installed.version !== entry.version ||
      installed.integrity !== entry.integrity ||
      installed.resolved !== entry.tarballUrl
    )
      fail();
  }
  verificationStage = "npm-audit";
  const { stdout } = await execute(
    "/usr/local/bin/node",
    [
      npm,
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--ignore-scripts",
      `--registry=${policy.registry}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: maximumOutputBytes,
    },
  );
  if (Buffer.byteLength(stdout) > maximumOutputBytes) fail();
  const audit = record(JSON.parse(stdout));
  if (
    !Array.isArray(audit.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit.missing) ||
    audit.missing.length !== 0 ||
    !Array.isArray(audit.verified) ||
    audit.verified.length !== packages.length
  )
    fail();
  verificationStage = "npm-bundles";
  for (const entry of packages) {
    const verified = audit.verified.find(
      (candidate) =>
        candidate?.name === entry.packageName &&
        candidate?.version === entry.version,
    );
    if (
      verified === undefined ||
      digest(canonical(verified.attestationBundles)) !==
        entry.attestationBundleDigest
    )
      fail();
  }
};

const verifyGpg = async (root, policy) => {
  if (policy.platformPackage !== undefined)
    await verifyPlatformPackage(root, policy);
  verificationStage = "gpg-home";
  const home = resolve(root, "gpg-home");
  mkdirSync(home, { mode: 0o700 });
  const common = gpgArguments(home);
  const environment = { HOME: home, LANG: "C.UTF-8", PATH: "/usr/bin:/bin" };
  verificationStage = "gpg-import";
  await execute("/usr/bin/gpg", [...common, "--import", resolve(root, "key")], {
    cwd: root,
    env: environment,
    maxBuffer: maximumOutputBytes,
  });
  verificationStage = "gpg-list";
  const { stdout: listing } = await execute(
    "/usr/bin/gpg",
    [...common, "--with-colons", "--fingerprint", "--list-keys"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: maximumOutputBytes,
    },
  );
  verificationStage = "gpg-key-policy";
  const fingerprints = listing
    .split("\n")
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9])
    .filter(Boolean);
  if (
    listing.split("\n").filter((line) => line.startsWith("pub:")).length !==
      1 ||
    fingerprints[0] !== policy.primaryFingerprint ||
    !fingerprints.includes(policy.signerFingerprint)
  )
    fail();
  verificationStage = "gpg-signature";
  const { stdout } = await execute(
    "/usr/bin/gpg",
    [
      ...common,
      "--status-fd=1",
      "--verify",
      resolve(root, "signature"),
      resolve(root, "manifest"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: maximumOutputBytes,
    },
  );
  verificationStage = "gpg-signature-policy";
  const status = stdout
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] "));
  if (
    status.some((line) =>
      /\b(?:BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|NO_PUBKEY)\b/u.test(
        line,
      ),
    )
  )
    fail();
  const valid = status.filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  const good = status.filter((line) => line.startsWith("[GNUPG:] GOODSIG "));
  const fields = valid[0]?.split(" ").slice(2);
  const algorithm = { 8: "sha256", 9: "sha384", 10: "sha512" }[fields?.[7]];
  if (
    valid.length !== 1 ||
    good.length !== 1 ||
    fields?.[0] !== policy.signerFingerprint ||
    (fields?.[9] ?? fields?.[0]) !== policy.primaryFingerprint ||
    fields?.[8] !== "00" ||
    algorithm !== policy.signatureHashAlgorithm ||
    !good[0].endsWith(` ${policy.uid}`)
  )
    fail();
};

const streamPlatformMember = (archive, descriptor, deadline) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/tar",
      [
        "--use-compress-program=/usr/bin/gzip",
        "--extract",
        "--to-stdout",
        "--file",
        archive,
        "--",
        "package/claude",
      ],
      {
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let bytes = 0,
      stderrBytes = 0,
      rejected = false;
    const hash = createHash("sha256");
    const stop = () => {
      rejected = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
    child.stdout.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        stop();
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > descriptor.memberBytes || performance.now() >= deadline)
        stop();
      else hash.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        stop();
        return;
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 65_536) stop();
    });
    child.once("error", () => {
      rejected = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (
        rejected ||
        code !== 0 ||
        stderrBytes !== 0 ||
        bytes !== descriptor.memberBytes ||
        hash.digest("hex") !== descriptor.memberSha256
      )
        reject(new Error("integration.harness-material-command.failed"));
      else resolve();
    });
  });

const verifyPlatformPackage = async (root, policy) => {
  verificationStage = "platform-archive";
  const descriptor = record(policy.platformPackage);
  if (
    !Number.isSafeInteger(policy.maximumMilliseconds) ||
    policy.maximumMilliseconds < 1 ||
    policy.maximumMilliseconds > 300_000 ||
    !Number.isSafeInteger(descriptor.memberBytes) ||
    descriptor.memberBytes < 1 ||
    descriptor.memberBytes > 384 * 1024 * 1024 ||
    descriptor.memberName !== "package/claude"
  )
    fail();
  const deadline = performance.now() + policy.maximumMilliseconds;
  const archive = resolve(root, "platform.tgz");
  const bytes = readFileSync(archive);
  if (
    bytes.byteLength !== descriptor.bytes ||
    bytes.byteLength > 312 * 1024 * 1024 ||
    digest(bytes) !== descriptor.sha256 ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
      descriptor.integrity
  )
    fail();
  bytes.fill(0);
  verificationStage = "platform-inventory";
  const { stdout, stderr } = await execute(
    "/usr/bin/tar",
    [
      "--use-compress-program=/usr/bin/gzip",
      "--list",
      "--verbose",
      "--numeric-owner",
      "--full-time",
      "--quoting-style=literal",
      "--file",
      archive,
    ],
    {
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      maxBuffer: 65_536,
      timeout: Math.max(1, deadline - performance.now()),
      killSignal: "SIGKILL",
    },
  );
  const expected = new Set([
    "package/claude",
    "package/package.json",
    "package/LICENSE.md",
    "package/README.md",
  ]);
  if (Buffer.byteLength(stdout) > 4096 || stderr !== "") fail();
  for (const line of stdout.trimEnd().split("\n")) {
    const fields =
      /^-[rwx-]{9} \d+\/\d+\s+(\d+) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (package\/[A-Za-z.]+)$/u.exec(
        line,
      );
    if (
      fields === null ||
      !expected.delete(fields[2]) ||
      (fields[2] === descriptor.memberName &&
        Number(fields[1]) !== descriptor.memberBytes)
    )
      fail();
  }
  if (expected.size !== 0 || performance.now() >= deadline) fail();
  verificationStage = "platform-member";
  await streamPlatformMember(archive, descriptor, deadline);
};

const [operation, root] = process.argv.slice(2);
if (
  !["gpg-verify", "npm-verify", "bootstrap-gpg"].includes(operation ?? "") ||
  root !== "/verify"
)
  fail();
const policy = readJson(resolve(root, "policy.json"));
try {
  if (operation === "npm-verify") await verifyNpm(root, policy);
  else if (operation === "gpg-verify") await verifyGpg(root, policy);
  else {
    const { runBootstrapGpgVerification } = await import("./bootstrap-gpg.mjs");
    await runBootstrapGpgVerification(policy.kind, execute);
  }
} catch {
  if (operation !== "bootstrap-gpg") {
    try {
      writeSync(2, `[agentscope-verifier:v1 failure=${verificationStage}]\n`);
    } catch {
      // Diagnostic delivery cannot replace the original failed command.
    }
  }
  process.exitCode = 1;
}
