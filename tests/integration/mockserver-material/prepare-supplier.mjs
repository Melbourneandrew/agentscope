/* eslint import-x/no-cycle: "off" -- existing private material/controller facade */
/** Connected supplier research, not offline build or service admission. */
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
import {
  exactDirectory,
  readMaterialSource,
  sameDirectory,
  writeExclusive,
} from "../harness-material-io.mjs";
import {
  buildPreparedDockerImage,
  markPreparedDockerClientForOuterHostRetirement,
} from "../image-preparation.mjs";
import { verifyBootstrapArchive } from "./bootstrap-archive.mjs";
import { verifyMavenArchiveBytes } from "./build-tool-archive.mjs";
import { prepareMockServerBootstrap } from "./prepare-bootstrap.mjs";
import { verifyMockServerSourceArchive } from "./source-archive.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const modules = Object.freeze(
  Object.fromEntries(
    [
      "supplier-command.mjs",
      "supplier-inventory.mjs",
      "build-recipe.mjs",
      "callback-patch.mjs",
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
    "FROM scratch",
    "COPY --from=supplier --chmod=0644 /out/material.json /material.json",
    "",
  ].join("\n"),
);
const reserve = 6_000;
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

export const researchMockServerSupplier = async (input) => {
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
  try {
    const bootstrap = await prepareMockServerBootstrap({
      ...input,
      signal: workSignal,
    });
    check(workSignal, deadline - reserve);
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
    const files = { ...archives, "Supplier.Dockerfile": dockerfile };
    for (const [name, snapshot] of Object.entries(modules)) {
      if (
        createHash("sha256").update(snapshot.bytes).digest("hex") !==
        snapshot.sha256
      )
        fail();
      files[name] = snapshot.bytes;
    }
    for (const [name, bytes] of Object.entries(files)) {
      check(workSignal, deadline - reserve);
      sameDirectory(owned.root);
      const path = resolve(rootPath, name);
      writeExclusive(path, bytes);
      owned.files.push({ path, status: lstatSync(path) });
    }
    check(workSignal, deadline - reserve);
    const inventory = await buildPreparedDockerImage(dockerClient, {
      buildArguments: { BASE_IMAGE: base },
      buildNetwork: "default",
      buildOutput: "evidence-tar",
      context: rootPath,
      dockerfile: "Supplier.Dockerfile",
      labels: {
        "com.agentscope.integration": "true",
        "com.agentscope.integration.run": runId,
      },
      maximumBuildContextBytes: 384 * 1024 * 1024,
      maximumMilliseconds: Math.floor(deadline - reserve - performance.now()),
      retirementRequired: false,
      signal: workSignal,
    });
    check(workSignal, deadline - reserve);
    if (
      !Buffer.isBuffer(inventory) ||
      inventory.length < 1 ||
      inventory.length > 8 * 1024 * 1024
    )
      fail();
    const bytes = Buffer.from(inventory);
    cleanup(owned, deadline);
    owned = undefined;
    created = false;
    check(signal, deadline);
    return Object.freeze({
      evidenceScope: "untrusted-cache-and-jar-research-only",
      inventory: bytes,
      bootstrapVerification: bootstrap.verification,
    });
  } catch (error) {
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
