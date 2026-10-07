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
import { promisify } from "node:util";
import { verifyBootstrapArchive } from "./bootstrap-archive.mjs";
import {
  mockServerSupplierBuildPlan,
  mockServerSupplierLayout,
  supplierGlobalMavenSettings,
  supplierMavenSettings,
} from "./build-recipe.mjs";
import { verifyMavenArchiveBytes } from "./build-tool-archive.mjs";
import { patchCallbackSource } from "./callback-patch.mjs";
import { verifyMockServerSourceArchive } from "./source-archive.mjs";
import { inventoryMockServerSupplier } from "./supplier-inventory.mjs";

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
const enter = (stage) => {
  try {
    writeSync(2, `[agentscope-material:v1 stage=${stage} family=none]\n`);
  } catch {
    // Optional last-entered observation, never the operation's outcome.
  }
};
const enterSupplier = (observe, stage) => {
  // Connected CLI uses an earlier fixed sequence; standalone exports retain
  // their original stages. These observations never describe an outcome.
  enter(observe ? stage : stage.replace("supplier-", "supplier-connected-"));
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
const readFixed = (path, size, mode = 0o600) => {
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
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "mtimeMs",
        "ctimeMs",
      ].some((key) => before[key] !== after[key])
    )
      throw new Error("integration.mockserver-material.supplier-command");
    return bytes;
  } finally {
    closeSync(fd);
  }
};

const cacheFields = ["dev", "ino", "mode", "uid", "gid"];
const adoptCache = (path, expected) => {
  const parent = lstatSync("/supplier");
  const named = lstatSync(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const held = fstatSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    const currentParent = lstatSync("/supplier");
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== 0 ||
      parent.gid !== 0 ||
      ![0o700, 0o755].includes(parent.mode & 0o7777) ||
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      !held.isDirectory() ||
      held.uid !== 0 ||
      held.gid !== 0 ||
      held.dev !== parent.dev ||
      (held.mode & 0o7777) !== 0o700 ||
      cacheFields.some(
        (key) =>
          named[key] !== held[key] ||
          held[key] !== after[key] ||
          held[key] !== current[key] ||
          parent[key] !== currentParent[key] ||
          (expected !== undefined && held[key] !== expected[key]),
      )
    )
      throw new Error("integration.mockserver-material.supplier-command");
    return held;
  } finally {
    closeSync(fd);
  }
};

const runSupplier = async (run, phase, observe = true) => {
  const plan = mockServerSupplierBuildPlan(phase);
  const caches = ["maven-repository", "npm-cache"];
  const adopted =
    phase === "offline-build"
      ? caches.map((name) => adoptCache(`/supplier/${name}`))
      : [];
  enterSupplier(observe, "supplier-entry");
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
  if (phase === "dependency-research")
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
  const callback = mockServerSupplierLayout.callback;
  writeFileSync(
    callback,
    patchCallbackSource(readFixed(callback, 9101, 0o664)),
    {
      flag: "w",
      mode: 0o644,
    },
  );
  writeFileSync("/supplier/settings.xml", supplierMavenSettings, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync("/supplier/global-settings.xml", supplierGlobalMavenSettings, {
    flag: "wx",
    mode: 0o600,
  });
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
  await run(plan.executable, [...plan.arguments], {
    cwd: plan.cwd,
    env: plan.environment,
    maxBuffer: maximumOutputBytes,
  });
  for (const [index, before] of adopted.entries())
    adoptCache(`/supplier/${caches[index]}`, before);
  enterSupplier(observe, "supplier-inventory");
  const inventory = inventoryMockServerSupplier("/supplier", (category) => {
    if (category === "inventory-read")
      enterSupplier(observe, "supplier-inventory-read");
    else if (category === "inventory-guard")
      enterSupplier(observe, "supplier-inventory-guard");
    else if (category === "inventory-internal")
      enterSupplier(observe, "supplier-inventory-internal");
  });
  writeInventory(inventory, observe);
};

export const runMockServerSupplierResearch = async (run) =>
  runSupplier(run, "dependency-research");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (
    process.argv.length !== 3 ||
    !["dependency-research", "offline-build"].includes(process.argv[2])
  )
    throw new Error("integration.mockserver-material.supplier-command");
  try {
    await runSupplier(
      execute,
      process.argv[2],
      process.argv[2] === "offline-build",
    );
  } catch {
    process.exitCode = 1;
  }
}
