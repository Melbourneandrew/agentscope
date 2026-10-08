/** Closed command inside the same disposable builder, never workstation use. */
import { execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify, types } from "node:util";
import { verifyBootstrapArchive } from "./bootstrap-archive.mjs";
import {
  mockServerSupplierBuildPlan,
  mockServerSupplierLayout,
  supplierGlobalMavenSettings,
  supplierMavenSettings,
} from "./build-recipe.mjs";
import { verifyMavenArchiveBytes } from "./build-tool-archive.mjs";
import { patchCallbackSource } from "./callback-patch.mjs";
import {
  firstSupplierCheckstyleObservation,
  lifecycleSourcePins,
  supplierSourceUnit,
  patchMockServerLifecycleSource,
} from "./lifecycle-patch.mjs";
import { verifyMockServerSourceArchive } from "./source-archive.mjs";
import {
  adoptMockServerSupplierCache as adoptCache,
  inventoryMockServerSupplier,
} from "./supplier-inventory.mjs";

const maximumOutputBytes = 8 * 1024 * 1024;
const execute = promisify(execFile);
const environment = {
  HOME: "/supplier/home",
  LANG: "C.UTF-8",
  PATH: "/usr/bin:/bin",
};
const options = {
  cwd: "/supplier",
  env: environment,
  maxBuffer: maximumOutputBytes,
};
const enter = (stage, failure = "") => {
  try {
    writeSync(
      2,
      `[agentscope-material:v1 stage=${stage} family=none${failure}]\n`,
    );
  } catch {
    // Optional last-entered observation, never the operation's outcome.
  }
};
const enterSupplier = (observe, stage, failure) => {
  // Connected CLI uses an earlier fixed sequence; standalone exports retain
  // their original stages. These observations never describe an outcome.
  enter(
    observe ? stage : stage.replace("supplier-", "supplier-connected-"),
    failure,
  );
};
// Authenticated POM coordinates only; zero means unobserved, never output text.
const mavenGoals = [
  "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile",
  "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:testCompile",
  "org.codehaus.mojo:templating-maven-plugin:3.1.0:filter-sources",
  "org.apache.maven.plugins:maven-enforcer-plugin:3.6.3:enforce",
  "org.apache.maven.plugins:maven-checkstyle-plugin:3.6.0:check",
  "org.codehaus.mojo:flatten-maven-plugin:1.8.0:flatten",
  "io.github.git-commit-id:git-commit-id-maven-plugin:9.0.1:revision",
  "com.github.eirslett:frontend-maven-plugin:2.0.0:install-node-and-npm",
  "com.github.eirslett:frontend-maven-plugin:2.0.0:npm",
  "org.apache.maven.plugins:maven-resources-plugin:3.5.0:copy-resources",
  "org.codehaus.mojo:exec-maven-plugin:3.6.3:exec",
  "org.apache.maven.plugins:maven-assembly-plugin:3.8.0:single",
];
const javacReasons = [
  "cannot find symbol",
  "incompatible types",
  "method does not override or implement a method from a supertype",
  "illegal start of expression",
  "';' expected",
  "reached end of file while parsing",
];
const packageOutput = (error) => {
  if (types.isProxy(error) || !types.isNativeError(error)) return null;
  const output = ["stdout", "stderr"].map(
    (key) => Object.getOwnPropertyDescriptor(error, key)?.value,
  );
  if (output.some((value) => typeof value !== "string")) return null;
  if (
    output.some((value) => value.length > maximumOutputBytes) ||
    output.reduce((sum, value) => sum + Buffer.byteLength(value), 0) >
      maximumOutputBytes
  )
    return false;
  return output.join("\n");
};
const packageFailureRecord = (error) => {
  const record = ["absent", 0, 0, 0, 0, 0, 0, 0];
  try {
    if (types.isProxy(error) || !types.isNativeError(error)) return record;
    const own = (key) => Object.getOwnPropertyDescriptor(error, key)?.value;
    const code = own("code"),
      signal = own("signal");
    record[1] =
      Number.isInteger(code) && code >= 0 && code <= 255 ? code + 1 : 0;
    record[2] = ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].indexOf(signal) + 1;
    const text = packageOutput(error);
    if (text === null) return record;
    if (text === false) {
      record[0] = "overflow";
      return record;
    }
    const [goal, secondGoal] = text.matchAll(
      /^\[ERROR\] Failed to execute goal ([a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+:[0-9.]+:[a-zA-Z0-9-]+) /gmu,
    );
    if (secondGoal !== undefined) {
      record[0] = "ambiguous";
      return record;
    }
    if (goal !== undefined) {
      record[3] = mavenGoals.indexOf(goal[1]) + 1;
      record[0] = record[3] === 0 ? "unlisted" : "identified";
    }
    if (record[3] === 5) {
      record.splice(4, 4, ...firstSupplierCheckstyleObservation(text));
      return record;
    }
    const [compiler, secondCompiler] = text.matchAll(
      /^\[ERROR\] \/[^\r\n]*\/([A-Za-z]+\.java):\[([0-9]{1,6}),([0-9]{1,6})\] ([^\r\n]*)$/gmu,
    );
    if (secondCompiler !== undefined) {
      record[0] = "ambiguous";
      record.fill(0, 4);
      return record;
    }
    if (compiler !== undefined) {
      const [, file, line, column, reason] = compiler;
      const unit = supplierSourceUnit(file);
      const category =
        javacReasons.findIndex(
          (value) => reason === value || reason.startsWith(`${value}:`),
        ) + 1;
      if (unit && category && Number(line) > 0 && Number(column) > 0) {
        record.splice(4, 4, unit, Number(line), Number(column), category);
        record[0] = "identified";
      }
    }
  } catch {
    record[0] = "absent";
  }
  return record;
};
const packageFailureStage = (error) => {
  try {
    const text = packageOutput(error);
    if (typeof text !== "string") return "supplier-package-other";
    const classes = [
      ["compilation", /^\[ERROR\] COMPILATION ERROR :\s*$/mu],
      [
        "resolution",
        /^\[ERROR\] Failed to execute goal on project [A-Za-z0-9_.-]+: Could not resolve dependencies\b/mu,
      ],
      [
        "frontend",
        /^\[ERROR\] Failed to execute goal com\.github\.eirslett:frontend-maven-plugin:[0-9.]+:(?:install-node-and-npm|npm) /mu,
      ],
    ].filter(([, pattern]) => pattern.test(text));
    return classes.length === 1
      ? `supplier-package-${classes[0][0]}`
      : "supplier-package-other";
  } catch {
    return "supplier-package-other";
  }
};
const runPackage = async (run, plan, observe) => {
  try {
    await run(plan.executable, [...plan.arguments], {
      cwd: plan.cwd,
      env: plan.environment,
      maxBuffer: maximumOutputBytes,
    });
  } catch (error) {
    enterSupplier(
      observe,
      packageFailureStage(error),
      ` maven=${packageFailureRecord(error).join(",")}`,
    );
    throw error;
  }
};
const writeInventory = (inventory, observe) => {
  try {
    mkdirSync("/out", { mode: 0o700 });
  } catch (error) {
    enterSupplier(observe, "supplier-output-create");
    throw error;
  }
  try {
    writeFileSync("/out/material.json", inventory, { flag: "wx", mode: 0o644 });
  } catch (error) {
    enterSupplier(observe, "supplier-output-write");
    throw error;
  }
};
const fileIdentityFields = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeMs",
  "ctimeMs",
];
const readFixed = (path, size, mode = 0o600, expected) => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== size ||
      before.uid !== 0 ||
      before.gid !== 0 ||
      (before.mode & 0o7777) !== mode
    )
      throw new Error("integration.mockserver-material.supplier-command");
    if (
      expected !== undefined &&
      fileIdentityFields.some((field) => before[field] !== expected[field])
    )
      throw new Error("integration.mockserver-material.supplier-command");
    const bytes = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      const length = readSync(fd, bytes, position, size - position, position);
      if (length === 0)
        throw new Error("integration.mockserver-material.supplier-command");
      position += length;
    }
    const after = fstatSync(fd);
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, position) !== 0 ||
      fileIdentityFields.some((key) => before[key] !== after[key])
    )
      throw new Error("integration.mockserver-material.supplier-command");
    return bytes;
  } finally {
    closeSync(fd);
  }
};

const cacheFields = ["dev", "ino", "mode", "uid", "gid"];
const patchSupplierSource = (service) => {
  const callback = mockServerSupplierLayout.callback;
  writeFileSync(
    callback,
    patchCallbackSource(readFixed(callback, 9101, 0o664)),
    {
      flag: "w",
      mode: 0o644,
    },
  );
  if (service) {
    for (const pin of lifecycleSourcePins) {
      const path = `/supplier/source/${pin.path}`;
      writeFileSync(
        path,
        patchMockServerLifecycleSource(
          pin.name,
          readFixed(path, pin.bytes, 0o664),
        ),
        { flag: "w", mode: 0o644 },
      );
    }
  }
};
const finishServiceArtifact = (caches) => {
  // Service preparation copies this exact held artifact inside the same builder;
  // research cache adoption remains non-authoritative diagnostic work.
  for (const name of caches) adoptCache(`/supplier/${name}`);
  const artifact = mockServerSupplierLayout.artifact;
  const named = lstatSync(artifact);
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1 ||
    named.size < 1 ||
    named.size > 256 * 1024 * 1024
  )
    throw new Error("integration.mockserver-material.supplier-command");
  readFixed(artifact, named.size, 0o644, named);
  const current = lstatSync(artifact);
  if (
    [...cacheFields, "nlink", "size", "mtimeMs", "ctimeMs"].some(
      (field) => named[field] !== current[field],
    )
  )
    throw new Error("integration.mockserver-material.supplier-command");
};

const adoptInitialCache = (name, index, observe) => {
  const stage = `supplier-cache-${index === 0 ? "maven" : "npm"}`;
  enterSupplier(observe, stage);
  return adoptCache(`/supplier/${name}`, undefined, (reason) =>
    enterSupplier(observe, `${stage}-${reason}`),
  );
};
const runSupplier = async (run, phase, observe = true) => {
  const service = phase === "cache-seeding" || phase === "service-offline";
  const offline = phase === "offline-build" || phase === "service-offline";
  const plan = mockServerSupplierBuildPlan(
    service ? (offline ? "offline-build" : "dependency-research") : phase,
  );
  const caches = ["maven-repository", "npm-cache"];
  enterSupplier(observe, "supplier-entry");
  const adopted = offline
    ? caches.map((name, index) => adoptInitialCache(name, index, observe))
    : [];
  // Only exact previously authenticated archives are admitted. Host staging also
  // authenticates them; this rejects mutation at the actual extraction boundary.
  verifyMockServerSourceArchive(
    readFixed("/supplier/inputs/source.tar.gz", 31_447_709),
  );
  verifyMavenArchiveBytes(readFixed("/supplier/inputs/maven.zip", 9_395_475));
  verifyBootstrapArchive(
    "node",
    readFixed("/supplier/inputs/node.tar.gz", 54_108_748),
  );
  verifyBootstrapArchive(
    "jdk",
    readFixed("/supplier/inputs/jdk.tar.gz", 193_252_603),
  );
  enterSupplier(observe, "supplier-extract");
  for (const name of [
    "home",
    "source",
    "tools",
    "tools/node",
    "tools/jdk-17.0.20.1+1",
    "maven-home",
  ])
    mkdirSync(`/supplier/${name}`, { mode: 0o700 });
  if (!offline)
    for (const name of caches) mkdirSync(`/supplier/${name}`, { mode: 0o700 });
  for (const [archive, destination] of [
    ["source", "/supplier/source"],
    ["node", "/supplier/tools/node"],
    ["jdk", "/supplier/tools/jdk-17.0.20.1+1"],
  ])
    await run(
      "/usr/bin/tar",
      [
        "--extract",
        "--gzip",
        "--file",
        `/supplier/inputs/${archive}.tar.gz`,
        "--directory",
        destination,
        "--strip-components=1",
        "--no-same-owner",
      ],
      options,
    );
  await run(
    "/usr/bin/unzip",
    ["-q", "/supplier/inputs/maven.zip", "-d", "/supplier/tools"],
    options,
  );
  patchSupplierSource(service);
  for (const [name, content] of [
    ["settings.xml", supplierMavenSettings],
    ["global-settings.xml", supplierGlobalMavenSettings],
  ])
    writeFileSync(`/supplier/${name}`, content, { flag: "wx", mode: 0o600 });
  for (const name of ["user.npmrc", "global.npmrc"])
    writeFileSync(`/supplier/${name}`, "", { flag: "wx", mode: 0o600 });
  // Seed the exact upstream frontend-plugin layout without skipping its install,
  // npm-ci or npm-build goals. Bundled npm belongs to this same Node archive.
  const frontend =
    "/supplier/source/mockserver/mockserver-netty/target/frontend/node";
  mkdirSync(frontend, { recursive: true, mode: 0o700 });
  copyFileSync(
    "/supplier/tools/node/bin/node",
    `${frontend}/node`,
    constants.COPYFILE_EXCL,
  );
  mkdirSync(`${frontend}/node_modules`, { mode: 0o700 });
  // Stock tar preserves the bundled npm tree and internal symlink relationships.
  await run(
    "/usr/bin/tar",
    [
      "--extract",
      "--gzip",
      "--file",
      "/supplier/inputs/node.tar.gz",
      "--directory",
      `${frontend}/node_modules`,
      "--strip-components=3",
      "--no-same-owner",
      "node-v22.14.0-linux-x64/lib/node_modules/npm",
    ],
    options,
  );
  enterSupplier(observe, "supplier-package");
  await runPackage(run, plan, observe);
  try {
    for (const [index, before] of adopted.entries())
      adoptCache(`/supplier/${caches[index]}`, before);
    if (service) {
      finishServiceArtifact(caches);
      return;
    }
  } catch (error) {
    enterSupplier(observe, "supplier-service-finalization");
    throw error;
  }
  enterSupplier(observe, "supplier-inventory");
  const inventory = inventoryMockServerSupplier("/supplier", (category) => {
    if (
      ["inventory-read", "inventory-guard", "inventory-internal"].includes(
        category,
      )
    )
      enterSupplier(observe, `supplier-${category}`);
  });
  writeInventory(inventory, observe);
};

export const runMockServerSupplierResearch = async (run) =>
  runSupplier(run, "dependency-research");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (
    process.argv.length !== 3 ||
    ![
      "dependency-research",
      "offline-build",
      "cache-seeding",
      "service-offline",
    ].includes(process.argv[2])
  )
    throw new Error("integration.mockserver-material.supplier-command");
  try {
    await runSupplier(
      execute,
      process.argv[2],
      process.argv[2] === "offline-build" ||
        process.argv[2] === "service-offline",
    );
  } catch {
    process.exitCode = 1;
  }
}
