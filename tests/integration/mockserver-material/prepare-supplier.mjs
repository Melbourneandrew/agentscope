/* eslint import-x/no-cycle: "off" -- existing private material/controller facade */
/** Connected cache preparation and fresh offline build, never service admission. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  exactDirectory,
  readMaterialSource,
  sameDirectory,
  writeExclusive,
} from "../harness-material-io.mjs";
import {
  buildPreparedDockerImage,
  markPreparedDockerClientForOuterHostRetirement,
  preparedDockerClientDiagnostic,
} from "../image-preparation.mjs";
import { verifyBootstrapArchive } from "./bootstrap-archive.mjs";
import { verifyMavenArchiveBytes } from "./build-tool-archive.mjs";
import { prepareMockServerBootstrap } from "./prepare-bootstrap.mjs";
import { verifyMockServerSourceArchive } from "./source-archive.mjs";
import {
  publishBootstrapGpgObservation,
  publishMaterialResearchPhase,
} from "../controller-file-command.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const modules = Object.freeze(
  Object.fromEntries(
    [
      "supplier-command.mjs",
      "supplier-inventory.mjs",
      "build-recipe.mjs",
      "callback-patch.mjs",
      "lifecycle-patch.mjs",
      "source-archive.mjs",
      "build-tool-archive.mjs",
      "bootstrap-archive.mjs",
    ].map((name) => [name, readMaterialSource(resolve(directory, name))]),
  ),
);
const base =
  "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const dockerfile = Buffer.from(
  [
    "ARG BASE_IMAGE",
    "FROM ${BASE_IMAGE} AS supplier",
    "WORKDIR /supplier",
    "COPY --chmod=0600 *.mjs /supplier/command/",
    "COPY --chmod=0600 source.tar.gz maven.zip node.tar.gz jdk.tar.gz /supplier/inputs/",
    'RUN --network=default ["/usr/local/bin/node", "/supplier/command/supplier-command.mjs", "dependency-research"]',
    "FROM ${BASE_IMAGE} AS offline",
    "WORKDIR /supplier",
    "COPY --chmod=0600 *.mjs /supplier/command/",
    "COPY --chmod=0600 source.tar.gz maven.zip node.tar.gz jdk.tar.gz /supplier/inputs/",
    "COPY --from=supplier /supplier/maven-repository /supplier/maven-repository",
    "COPY --from=supplier /supplier/npm-cache /supplier/npm-cache",
    'RUN --network=none ["/usr/local/bin/node", "/supplier/command/supplier-command.mjs", "offline-build"]',
    "FROM scratch",
    "COPY --from=offline --chmod=0644 /out/material.json /material.json",
    "",
  ].join("\n"),
);
const reserve = 6_000;
const serviceDockerfile = Buffer.from(
  dockerfile
    .toString("utf8")
    .replace('"dependency-research"]', '"cache-seeding"]')
    .replace('"offline-build"]', '"service-offline"]')
    .replace(
      "FROM scratch\nCOPY --from=offline --chmod=0644 /out/material.json /material.json",
      [
        "FROM ${BASE_IMAGE}",
        "COPY --from=offline /supplier/tools/jdk-17.0.20.1+1 /opt/java",
        "COPY --from=offline --chmod=0444 /supplier/source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar /opt/mockserver.jar",
        "COPY --chmod=0600 control-private.pem control-jwks.json /opt/control/",
        "COPY --chmod=0444 expectations.json /config/expectations.json",
        "USER 0:0",
        'ENTRYPOINT ["/bin/sh", "-ec", "umask 077; mkdir /control/private; cp /opt/control/control-private.pem /control/private/control-private.pem; cp /opt/control/control-jwks.json /control/private/control-jwks.json; exec /opt/java/bin/java -jar /opt/mockserver.jar -serverPort 1080"]',
      ].join("\n"),
    ),
);
const fail = () => {
  throw new Error("integration.mockserver-material.supplier");
};
const check = (signal, deadline) => {
  if (signal.aborted || performance.now() >= deadline) fail();
};
const fields = [
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
const sameFile = (file) => {
  const current = lstatSync(file.path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    fields.some((field) => current[field] !== file.status[field])
  )
    fail();
};
const cleanup = (owned, deadline) => {
  check({ aborted: false }, deadline);
  sameDirectory(owned.parent);
  sameDirectory(owned.root);
  const expected = owned.files
    .map((file) => file.path.split("/").at(-1))
    .sort();
  if (
    JSON.stringify(readdirSync(owned.root.path).sort()) !==
    JSON.stringify(expected)
  )
    fail();
  for (const file of owned.files) sameFile(file);
  for (const file of owned.files) {
    check({ aborted: false }, deadline);
    sameDirectory(owned.root);
    sameFile(file);
    unlinkSync(file.path);
  }
  sameDirectory(owned.parent);
  sameDirectory(owned.root);
  rmdirSync(owned.root.path);
  check({ aborted: false }, deadline);
};

const supplierContextFiles = (archives, service) => {
  const files = {
    ...archives,
    "Supplier.Dockerfile":
      service === undefined ? dockerfile : serviceDockerfile,
  };
  if (service !== undefined) {
    if (
      !/^agentscope-int-[a-f0-9]{16}:mockserver$/u.test(service.tag ?? "") ||
      !Buffer.isBuffer(service.privateKey) ||
      service.privateKey.length < 1 ||
      service.privateKey.length > 4096 ||
      !Buffer.isBuffer(service.jwks) ||
      service.jwks.length < 1 ||
      service.jwks.length > 4096 ||
      !Buffer.isBuffer(service.expectations) ||
      service.expectations.length < 1 ||
      service.expectations.length > 1024 * 1024
    )
      fail();
    files["control-private.pem"] = Buffer.from(service.privateKey);
    files["control-jwks.json"] = Buffer.from(service.jwks);
    files["expectations.json"] = Buffer.from(service.expectations);
  }
  for (const [name, snapshot] of Object.entries(modules)) {
    if (
      createHash("sha256").update(snapshot.bytes).digest("hex") !==
      snapshot.sha256
    )
      fail();
    files[name] = snapshot.bytes;
  }
  return files;
};

const preserveSupplierBuildFailure = (error, dockerClient) => {
  try {
    publishBootstrapGpgObservation(
      preparedDockerClientDiagnostic(dockerClient),
    );
  } catch {
    // Optional observation cannot replace the supplier's original failure.
  }
  throw error;
};

const observeSupplierFailure = (phase, dockerClient) => {
  try {
    const bytes = Buffer.from(
      `integration.mockserver-material.supplier-diagnostic:${JSON.stringify({
        phase,
        imagePreparation: preparedDockerClientDiagnostic(dockerClient) ?? null,
      })}\n`,
    );
    if (bytes.length > 4096) return;
    writeSync(2, bytes);
  } catch {
    // Optional owned diagnostics cannot replace the original failure.
  }
};

const prepareSupplier = async (input, service) => {
  const { deadline, dockerClient, privateRoot, runId, signal } = input;
  const budget = deadline - reserve - performance.now();
  if (
    !Number.isFinite(deadline) ||
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
  let created = false;
  let phase = "bootstrap-preflight";
  try {
    // Bootstrap owns its own cutoff at this same absolute deadline. Its original
    // caller signal must remain usable during reserved late-image retirement.
    const bootstrap = await prepareMockServerBootstrap(input);
    check(workSignal, deadline - reserve);
    phase = "supplier-context";
    publishMaterialResearchPhase("supplier-context");
    // Mutable returned bytes are never accepted on the strength of the receipt.
    const archives = {
      "source.tar.gz": verifyMockServerSourceArchive(bootstrap.archives.source),
      "maven.zip": verifyMavenArchiveBytes(bootstrap.archives.maven),
      "node.tar.gz": verifyBootstrapArchive("node", bootstrap.archives.node),
      "jdk.tar.gz": verifyBootstrapArchive("jdk", bootstrap.archives.jdk),
    };
    check(workSignal, deadline - reserve);
    const parent = exactDirectory(privateRoot);
    const rootPath = resolve(
      realpathSync(privateRoot),
      `mockserver-supplier-${runId}`,
    );
    const clientRoot = realpathSync(dockerClient.privateClient.root);
    if (
      rootPath === clientRoot ||
      rootPath.startsWith(`${clientRoot}/`) ||
      clientRoot.startsWith(`${rootPath}/`)
    )
      fail();
    mkdirSync(rootPath, { mode: 0o700 });
    created = true;
    owned = { parent, root: exactDirectory(rootPath), files: [] };
    if (owned.root.dev !== parent.dev) fail();
    const files = supplierContextFiles(archives, service);
    for (const [name, bytes] of Object.entries(files)) {
      check(workSignal, deadline - reserve);
      sameDirectory(owned.root);
      const path = resolve(rootPath, name);
      writeExclusive(path, bytes);
      owned.files.push({ path, status: lstatSync(path) });
    }
    check(workSignal, deadline - reserve);
    phase = "supplier-build";
    publishMaterialResearchPhase("supplier-build");
    const inventory = await buildPreparedDockerImage(dockerClient, {
      buildArguments: { BASE_IMAGE: base },
      buildNetwork: "default",
      buildOutput: service === undefined ? "evidence-tar" : "image",
      context: rootPath,
      dockerfile: "Supplier.Dockerfile",
      labels: {
        "com.agentscope.integration": "true",
        "com.agentscope.integration.run": runId,
      },
      maximumBuildContextBytes: 384 * 1024 * 1024,
      maximumMilliseconds: Math.floor(deadline - reserve - performance.now()),
      retirementRequired: service !== undefined,
      ...(service === undefined ? {} : { tag: service.tag }),
      signal: workSignal,
    }).catch((error) => preserveSupplierBuildFailure(error, dockerClient));
    check(workSignal, deadline - reserve);
    phase = "supplier-inventory";
    publishMaterialResearchPhase("supplier-inventory");
    if (
      service !== undefined
        ? !/^sha256-[a-f0-9]{64}$/u.test(inventory ?? "")
        : !Buffer.isBuffer(inventory) ||
          inventory.length < 1 ||
          inventory.length > 8 * 1024 * 1024
    )
      fail();
    const bytes = service === undefined ? Buffer.from(inventory) : undefined;
    phase = "supplier-cleanup";
    publishMaterialResearchPhase("supplier-cleanup");
    cleanup(owned, deadline);
    owned = undefined;
    created = false;
    check(signal, deadline);
    return service === undefined
      ? Object.freeze({
          evidenceScope: "untrusted-cache-and-jar-research-only",
          inventory: bytes,
          bootstrapVerification: bootstrap.verification,
        })
      : Object.freeze({
          imageId: inventory,
          tag: service.tag,
          bootstrapVerification: bootstrap.verification,
        });
  } catch (error) {
    observeSupplierFailure(phase, dockerClient);
    if (owned !== undefined) {
      try {
        cleanup(owned, deadline);
      } catch {
        markPreparedDockerClientForOuterHostRetirement(dockerClient);
      }
    } else if (created)
      markPreparedDockerClientForOuterHostRetirement(dockerClient);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const researchMockServerSupplier = (input) =>
  prepareSupplier(input, undefined);
/** Actual fresh offline image, not a whole-cache inventory certificate. */
export const prepareMockServerService = (input, service) =>
  prepareSupplier(input, service);
