/* eslint import-x/no-cycle: "off" -- existing private material/controller facade */
/** Owned bootstrap verification stage; not supplier or service admission. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { downloadMockServerJdkArchive } from "../harness-material.mjs";
import {
  exactDirectory,
  readMaterialSource,
  sameDirectory,
  writeExclusive,
} from "../harness-material-io.mjs";
import {
  buildPreparedDockerImage,
  markPreparedDockerClientForOuterHostRetirement,
  prepareDockerInvocation,
  preparedDockerClientDiagnostic,
  retirePreparedDockerImage,
} from "../image-preparation.mjs";
import { downloadMaterialObject } from "../material-download.mjs";
import {
  publishBootstrapGpgObservation,
  publishMaterialResearchPhase,
} from "../controller-file-command.mjs";
import { verifyBootstrapArchive } from "./bootstrap-archive.mjs";
import { verifyBootstrapMetadata } from "./bootstrap-metadata.mjs";
import { verifyMavenArchiveBytes } from "./build-tool-archive.mjs";
import { verifyMockServerSourceArchive } from "./source-archive.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const bootstrap = JSON.parse(
  readMaterialSource(resolve(directory, "bootstrap-pin.json")).bytes.toString(
    "utf8",
  ),
);
const maven = JSON.parse(
  readMaterialSource(resolve(directory, "build-tool-pin.json")).bytes.toString(
    "utf8",
  ),
).maven;
const source = JSON.parse(
  readMaterialSource(resolve(directory, "source-pin.json")).bytes.toString(
    "utf8",
  ),
);
const command = readMaterialSource(
  resolve(directory, "../harness-material-command.mjs"),
);
const helper = readMaterialSource(resolve(directory, "bootstrap-gpg.mjs"));
const base =
  "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const maximumContextBytes = 384 * 1024 * 1024;
const reserveMilliseconds = 6_000;
const fail = () => {
  throw new Error("integration.mockserver-material.bootstrap");
};
const check = (signal, deadline) => {
  if (
    signal.aborted ||
    !Number.isFinite(deadline) ||
    performance.now() >= deadline
  )
    fail();
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checkedObject = (bytes, pin) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== pin.bytes ||
    digest(bytes) !== pin.sha256
  )
    fail();
  return bytes;
};

const acquire = async (signal, deadline) => {
  const archives = {};
  for (const [kind, pin] of [
    ["source", source.archive],
    ["maven", maven.archive],
    ["node", bootstrap.node.archive],
  ]) {
    check(signal, deadline);
    publishMaterialResearchPhase(`download-${kind}`);
    archives[kind] = checkedObject(
      await downloadMaterialObject(pin, signal, deadline),
      pin,
    );
  }
  publishMaterialResearchPhase("download-jdk");
  archives.jdk = await downloadMockServerJdkArchive(signal, deadline);
  check(signal, deadline);
  // These return owned copies, with SHA512 additionally required for Maven.
  publishMaterialResearchPhase("verify-archives");
  archives.source = verifyMockServerSourceArchive(archives.source);
  archives.maven = verifyMavenArchiveBytes(archives.maven);
  archives.node = verifyBootstrapArchive("node", archives.node);
  archives.jdk = verifyBootstrapArchive("jdk", archives.jdk);
  const metadata = {};
  publishMaterialResearchPhase("pinned-metadata");
  for (const [name, pin] of Object.entries(bootstrap.metadata)) {
    check(signal, deadline);
    metadata[name] = verifyBootstrapMetadata(
      name,
      Buffer.from(pin.base64, "base64"),
    );
  }
  for (const [name, pin] of [
    ["maven-key", maven.publicKeyMetadata],
    ["maven-signature", maven.signature],
  ]) {
    check(signal, deadline);
    publishMaterialResearchPhase(`download-${name}`);
    metadata[name] = checkedObject(
      await downloadMaterialObject(pin, signal, deadline),
      pin,
    );
  }
  check(signal, deadline);
  return { archives, metadata };
};

const identityFields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size"];
const capture = (path) => ({ path, status: lstatSync(path) });
const sameFile = (identity) => {
  const current = lstatSync(identity.path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    identityFields.some((field) => current[field] !== identity.status[field])
  )
    fail();
};
const verificationKinds = ["maven", "node", "jdk"];
const kindFiles = (kind, objects) => ({
  "material-command.mjs": command.bytes,
  "bootstrap-gpg.mjs": helper.bytes,
  "policy.json": Buffer.from(`${JSON.stringify({ kind })}\n`),
  key: objects.metadata[kind === "jdk" ? "temurin-key" : `${kind}-key`],
  signature:
    objects.metadata[
      kind === "jdk"
        ? "temurin-signature"
        : kind === "node"
          ? "node-signed-checksums"
          : "maven-signature"
    ],
  manifest:
    kind === "node"
      ? objects.metadata["node-checksums"]
      : objects.archives[kind],
});
const contextFiles = (objects) => {
  const files = {},
    recipe = [];
  for (const kind of verificationKinds) {
    recipe.push(`FROM agentscope_base AS verify_${kind}`, "WORKDIR /verify");
    for (const [name, bytes] of Object.entries(kindFiles(kind, objects))) {
      files[`${kind}-${name}`] = bytes;
      recipe.push(`COPY --chmod=0600 ${kind}-${name} /verify/${name}`);
    }
    recipe.push(
      `RUN --network=none ${JSON.stringify(["/usr/local/bin/node", "/verify/material-command.mjs", "bootstrap-gpg", "/verify"])}`,
      `RUN --network=none ${JSON.stringify(["/usr/local/bin/node", "-e", `require('node:fs').writeFileSync('/proof-${kind}', '${kind}\\n', {flag:'wx',mode:0o600})`])}`,
    );
  }
  recipe.push("FROM scratch");
  for (const kind of verificationKinds)
    recipe.push(`COPY --from=verify_${kind} /proof-${kind} /proof/${kind}`);
  files["Verifier.Dockerfile"] = Buffer.from(`${recipe.join("\n")}\n`);
  return files;
};
const stageContext = (owned, kind, objects, signal, deadline) => {
  check(signal, deadline);
  if (
    digest(command.bytes) !== command.sha256 ||
    digest(helper.bytes) !== helper.sha256
  )
    fail();
  sameDirectory(owned.root);
  const path = resolve(owned.root.path, kind);
  mkdirSync(path, { mode: 0o700 });
  const context = { directory: exactDirectory(path), files: [] };
  owned.contexts.push(context);
  for (const [name, bytes] of Object.entries(contextFiles(objects))) {
    check(signal, deadline);
    sameDirectory(context.directory);
    writeExclusive(resolve(path, name), bytes);
    context.files.push(capture(resolve(path, name)));
  }
  check(signal, deadline);
  return path;
};
const cleanup = (owned, deadline) => {
  // Cleanup uses the original reserve even when work cancellation has fired.
  check({ aborted: false }, deadline);
  sameDirectory(owned.parent);
  sameDirectory(owned.root);
  const names = owned.contexts
    .map((context) => context.directory.path.split("/").at(-1))
    .sort();
  if (
    JSON.stringify(readdirSync(owned.root.path).sort()) !==
    JSON.stringify(names)
  )
    fail();
  for (const context of owned.contexts) {
    check({ aborted: false }, deadline);
    sameDirectory(owned.root);
    sameDirectory(context.directory);
    const files = context.files
      .map((file) => file.path.split("/").at(-1))
      .sort();
    if (
      JSON.stringify(readdirSync(context.directory.path).sort()) !==
      JSON.stringify(files)
    )
      fail();
    for (const file of context.files) sameFile(file);
    for (const file of context.files) {
      check({ aborted: false }, deadline);
      sameDirectory(context.directory);
      sameFile(file);
      unlinkSync(file.path);
    }
    sameDirectory(context.directory);
    rmdirSync(context.directory.path);
  }
  sameDirectory(owned.parent);
  sameDirectory(owned.root);
  rmdirSync(owned.root.path);
  check({ aborted: false }, deadline);
};

const verifyInputs = async (input, owned, objects, workSignal) => {
  const { deadline, dockerClient, runId, signal } = input;
  const workDeadline = deadline - reserveMilliseconds;
  check(workSignal, workDeadline);
  const context = stageContext(
    owned,
    "verification",
    objects,
    workSignal,
    workDeadline,
  );
  const tag = `agentscope-bootstrap:${runId}-verification`;
  // Existing first-kind phase denotes this one combined verifier operation;
  // it is not three independently observed image builds or retirements.
  publishMaterialResearchPhase("verify-maven");
  const imageId = await buildPreparedDockerImage(dockerClient, {
    buildArguments: {},
    baseImage: base,
    buildNetwork: "none",
    context,
    dockerfile: "Verifier.Dockerfile",
    labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": runId,
    },
    maximumBuildContextBytes: maximumContextBytes,
    maximumMilliseconds: Math.floor(workDeadline - performance.now()),
    retirementRequired: true,
    signal: workSignal,
    tag,
  }).catch((error) => {
    try {
      publishBootstrapGpgObservation(
        preparedDockerClientDiagnostic(dockerClient),
      );
    } catch {
      // Optional text observation must never replace the original failure.
    }
    throw error;
  });
  // Retire a successfully created reference even after late work completion.
  publishMaterialResearchPhase("retire-maven");
  await retirePreparedDockerImage(dockerClient, {
    deadline: Math.min(deadline - 1_000, performance.now() + 5_000),
    imageId,
    signal,
    tag,
  });
  check(workSignal, workDeadline);
  return verificationKinds.map((kind) => Object.freeze({ kind, imageId }));
};

/** Mutable returned archives must be reauthenticated before supplier staging. */
export const prepareMockServerBootstrap = async (input) => {
  publishMaterialResearchPhase("bootstrap-preflight");
  const { deadline, dockerClient, privateRoot, runId, signal } = input;
  const budget = deadline - reserveMilliseconds - performance.now();
  if (
    !Number.isFinite(deadline) ||
    !Number.isFinite(budget) ||
    budget < 1 ||
    deadline - performance.now() > 300_000 ||
    !(signal instanceof AbortSignal) ||
    signal.aborted ||
    !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
    typeof privateRoot !== "string" ||
    resolve(privateRoot) !== privateRoot
  )
    fail();
  const work = new AbortController();
  const timer = setTimeout(() => work.abort(), Math.floor(budget));
  const workSignal = AbortSignal.any([signal, work.signal]);
  let owned;
  let rootCreated = false;
  let primary;
  try {
    check(workSignal, deadline - reserveMilliseconds);
    await prepareDockerInvocation(dockerClient, ["version"], workSignal);
    check(workSignal, deadline - reserveMilliseconds);
    const images = dockerClient.evidence.images.filter(
      (image) => image.image === base,
    );
    if (
      images.length !== 1 ||
      images[0].platform.os !== "linux" ||
      images[0].platform.architecture !== "amd64" ||
      images[0].platform.variant
    )
      fail();
    const parent = exactDirectory(privateRoot);
    const physicalParent = realpathSync(privateRoot);
    const clientRoot = realpathSync(dockerClient.privateClient.root);
    const rootPath = resolve(physicalParent, `mockserver-bootstrap-${runId}`);
    if (
      rootPath === clientRoot ||
      rootPath.startsWith(`${clientRoot}/`) ||
      clientRoot.startsWith(`${rootPath}/`)
    )
      fail();
    mkdirSync(rootPath, { mode: 0o700 });
    rootCreated = true;
    owned = { parent, root: exactDirectory(rootPath), contexts: [] };
    if (owned.root.dev !== parent.dev) fail();
    const objects = await acquire(workSignal, deadline - reserveMilliseconds);
    const verifications = await verifyInputs(input, owned, objects, workSignal);
    publishMaterialResearchPhase("bootstrap-cleanup");
    cleanup(owned, deadline);
    owned = undefined;
    rootCreated = false;
    check(signal, deadline);
    return Object.freeze({
      archives: Object.freeze(objects.archives),
      verification: Object.freeze({
        evidenceScope: "bootstrap-input-verification-only",
        base,
        commandSha256: command.sha256,
        helperSha256: helper.sha256,
        verifications: Object.freeze(verifications),
      }),
    });
  } catch (error) {
    primary = error;
    if (owned !== undefined) {
      try {
        cleanup(owned, deadline);
      } catch {
        markPreparedDockerClientForOuterHostRetirement(dockerClient);
      }
    } else if (rootCreated) {
      // Creation without a bound identity is quarantined, never deleted.
      markPreparedDockerClientForOuterHostRetirement(dockerClient);
    }
    throw primary;
  } finally {
    clearTimeout(timer);
  }
};
