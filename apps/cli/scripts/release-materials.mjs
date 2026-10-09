/** Build observations only; neither signed attestation nor support authority. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (condition) =>
  assert(condition, "CLI release material is incomplete");
const file = (path) => {
  const before = lstatSync(path, { bigint: true });
  fail(before.isFile() && before.size <= 67_108_864n);
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
    fail(before[key] === after[key]);
  return bytes;
};
const localPath = (root, path) => {
  const value = relative(root, path).split("\\").join("/");
  fail(value !== "" && !value.startsWith("../") && !isAbsolute(value));
  return value;
};

function observedInvocation(root) {
  const names = [
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SHA",
  ];
  const entries = names.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  );
  if (entries.length === 0)
    return { environment: "local", authenticated: false };
  fail(entries.length === names.length);
  const values = Object.fromEntries(entries);
  fail(
    values.GITHUB_REPOSITORY === "Melbourneandrew/agentscope" &&
      /^[1-9][0-9]{0,19}$/u.test(values.GITHUB_RUN_ID) &&
      /^[1-9][0-9]{0,5}$/u.test(values.GITHUB_RUN_ATTEMPT) &&
      /^[a-f0-9]{40}$/u.test(values.GITHUB_SHA),
  );
  const prefix = `${values.GITHUB_REPOSITORY}/`;
  fail(values.GITHUB_WORKFLOW_REF.startsWith(prefix));
  const path = values.GITHUB_WORKFLOW_REF.slice(prefix.length).split("@")[0];
  fail(/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/u.test(path));
  return {
    environment: "github-actions",
    authenticated: false,
    repository: values.GITHUB_REPOSITORY,
    runId: values.GITHUB_RUN_ID,
    runAttempt: values.GITHUB_RUN_ATTEMPT,
    workflowRef: values.GITHUB_WORKFLOW_REF,
    sourceRevision: values.GITHUB_SHA,
    workflowSha256: sha(file(join(root, path))),
  };
}

function packageOwner(root, inputPath) {
  let cursor = dirname(inputPath);
  while (cursor !== root) {
    const path = join(cursor, "package.json");
    if (existsSync(path)) {
      const bytes = file(path);
      const value = JSON.parse(bytes.toString("utf8"));
      // Some published subdirectories have type-only package manifests.
      if (typeof value.name === "string" && typeof value.version === "string")
        return {
          name: value.name,
          version: value.version,
          license:
            typeof value.license === "string" ? value.license : "NOASSERTION",
          manifest: localPath(root, path),
          manifestSha256: sha(bytes),
        };
    }
    const parent = dirname(cursor);
    fail(parent !== cursor);
    cursor = parent;
  }
  throw new Error("CLI release input has no package owner");
}

function directoryFiles(root, current = root) {
  return readdirSync(current)
    .sort()
    .flatMap((name) => {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) return directoryFiles(root, path);
      fail(stat.isFile());
      const bytes = file(path);
      return [
        {
          path: localPath(root, path),
          bytes: bytes.length,
          sha256: sha(bytes),
        },
      ];
    });
}

function recordingPlugin(original, transformations) {
  return {
    name: original.name,
    setup(api) {
      original.setup({
        ...api,
        onLoad(options, callback) {
          api.onLoad(options, async (input) => {
            const result = await callback(input);
            if (result?.contents !== undefined) {
              const bytes = Buffer.from(result.contents);
              transformations.set(realpathSync(input.path), {
                plugin: original.name,
                bytes: bytes.length,
                sha256: sha(bytes),
              });
            }
            return result;
          });
        },
      });
    },
  };
}

function observeVirtualInput(name, metadata, options) {
  const defined = /^<define:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)>$/u.exec(
    name,
  );
  if (defined) {
    fail(Object.hasOwn(options.define ?? {}, defined[1]));
    const value = options.define[defined[1]];
    fail(typeof value === "string");
    const bytes = Buffer.from(value);
    fail(bytes.length === metadata.bytes);
    return {
      path: name,
      bytes: bytes.length,
      sha256: sha(bytes),
      virtual: true,
    };
  }
  fail(!name.startsWith("<"));
  if (name !== options.stdin?.sourcefile) return undefined;
  const bytes = Buffer.from(options.stdin.contents);
  fail(bytes.length === metadata.bytes);
  return { path: name, bytes: bytes.length, sha256: sha(bytes), virtual: true };
}

/** Observe the actual ordinary esbuild calls without changing their topology. */
export function createReleaseBuildRecorder({
  repositoryRoot,
  packageRoot,
  engine,
  version,
}) {
  const startedAt = new Date().toISOString();
  const builds = [];
  const transformations = new Map();
  const root = realpathSync(repositoryRoot);
  const packageDirectory = realpathSync(packageRoot);
  const observeInput = (name, metadata, options) => {
    const virtual = observeVirtualInput(name, metadata, options);
    if (virtual) return virtual;
    const path = realpathSync(resolve(packageDirectory, name));
    const bytes = file(path);
    const transformation = transformations.get(path);
    fail((transformation?.bytes ?? bytes.length) === metadata.bytes);
    return {
      path: localPath(root, path),
      bytes: bytes.length,
      sha256: sha(bytes),
      owner: packageOwner(root, path),
      ...(transformation === undefined ? {} : { transformation }),
    };
  };
  const runBuild = async (options) => {
    const result = await engine({
      ...options,
      absWorkingDir: packageDirectory,
      metafile: true,
    });
    fail(result.metafile !== undefined);
    const inputs = Object.entries(result.metafile.inputs).map(
      ([name, value]) => ({
        name,
        observed: observeInput(name, value, options),
      }),
    );
    const outputs = Object.entries(result.metafile.outputs).map(
      ([name, value], index) => {
        const bytes =
          options.write === false
            ? Buffer.from(result.outputFiles[index].contents)
            : file(resolve(packageDirectory, name));
        fail(bytes.length === value.bytes);
        return {
          path:
            options.write === false
              ? `embedded/${builds.length}/${index}.js`
              : localPath(packageDirectory, resolve(packageDirectory, name)),
          bytes: bytes.length,
          sha256: sha(bytes),
          embedded: options.write === false,
          inputs: Object.entries(value.inputs).map(([input, contribution]) => {
            const observed = inputs.find((row) => row.name === input)?.observed;
            fail(observed !== undefined);
            return {
              path: observed.path,
              bytesInOutput: contribution.bytesInOutput,
            };
          }),
        };
      },
    );
    builds.push({
      inputs: inputs.map(({ observed }) => observed),
      outputs,
      defines: Object.entries(options.define ?? {}).map(([name, value]) => {
        if (!name.endsWith("_PROGRAM__"))
          return { name, sha256: sha(Buffer.from(value)) };
        const program = JSON.parse(value);
        fail(typeof program === "string");
        const digest = sha(Buffer.from(program));
        fail(
          builds.some((invocation) =>
            invocation.outputs.some(
              (output) => output.embedded && output.sha256 === digest,
            ),
          ),
        );
        return { name, programSha256: digest };
      }),
    });
    return result;
  };
  return {
    build: runBuild,
    plugin: (original) => recordingPlugin(original, transformations),
    finish: () =>
      finishBuildObservation({
        builds,
        root,
        packageDirectory,
        startedAt,
        version,
      }),
  };
}

function finishBuildObservation({
  builds,
  root,
  packageDirectory,
  startedAt,
  version,
}) {
  fail(
    builds.length === 9 &&
      builds.filter((value) => value.outputs.some((output) => output.embedded))
        .length === 2,
  );
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  fail(/^[a-f0-9]{40}$/u.test(sourceRevision));
  const lock = file(join(root, "pnpm-lock.yaml"));
  const tool = JSON.parse(
    file(join(packageDirectory, "package.json")).toString("utf8"),
  );
  return {
    sourceRevision,
    sourceTreeDisposition:
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }).trim() === ""
        ? "clean"
        : "modified-working-tree",
    startedAt,
    invocation: observedInvocation(root),
    observedAt: new Date().toISOString(),
    tools: {
      node: process.versions.node,
      esbuild: version,
      packageManager: JSON.parse(
        file(join(root, "package.json")).toString("utf8"),
      ).packageManager,
    },
    package: { name: tool.name, version: tool.version },
    lockfile: { sha256: sha(lock), bytes: lock.length },
    scripts: [
      "apps/cli/build.mjs",
      "apps/cli/scripts/release-materials.mjs",
      "apps/cli/scripts/directory-artifact.mjs",
    ].map((path) => ({ path, sha256: sha(file(join(root, path))) })),
    builds,
    files: directoryFiles(join(packageDirectory, "dist")).map((value) => ({
      ...value,
      path: `dist/${value.path}`,
    })),
  };
}

function validatePackedFiles(build, inspected) {
  const actual = inspected.inventory.filter(
    (value) => value.path !== "package/package.json",
  );
  fail(actual.length === build.files.length);
  for (const expected of build.files) {
    const matches = actual.filter(
      (value) => value.path === `package/${expected.path}`,
    );
    fail(
      matches.length === 1 &&
        matches[0].bytes === expected.bytes &&
        matches[0].sha256 === `sha256:${expected.sha256}`,
    );
  }
  for (const invocation of build.builds)
    for (const output of invocation.outputs) {
      if (output.embedded) continue;
      const match = build.files.find((value) => value.path === output.path);
      fail(match?.sha256 === output.sha256 && match.bytes === output.bytes);
    }
}

function packageRows(build) {
  const owners = new Map();
  for (const invocation of build.builds) {
    const contributors = new Set(
      invocation.outputs.flatMap((output) =>
        output.inputs
          .filter((input) => input.bytesInOutput > 0)
          .map((input) => input.path),
      ),
    );
    for (const input of invocation.inputs) {
      if (input.virtual || !contributors.has(input.path)) continue;
      fail(input.owner !== undefined);
      const owner = input.owner;
      const key = `${owner.name}@${owner.version}:${owner.manifestSha256}`;
      owners.set(key, owner);
    }
  }
  return [...owners.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, owner]) => ({
      SPDXID: `SPDXRef-Component-${sha(key).slice(0, 24)}`,
      name: owner.name,
      versionInfo: owner.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseDeclared: owner.license,
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      sourceInfo: `Package metadata SHA256 ${owner.manifestSha256}; download identity not independently asserted`,
    }));
}

function createSpdxDocument(build, inspected, directoryRecords) {
  const components = packageRows(build);
  const files = inspected.inventory.map((value, index) => ({
    SPDXID: `SPDXRef-File-${index}`,
    fileName: value.path.slice("package/".length),
    checksums: [
      {
        algorithm: "SHA256",
        checksumValue: value.sha256.slice("sha256:".length),
      },
    ],
    licenseConcluded: "NOASSERTION",
    licenseInfoInFiles: ["NOASSERTION"],
    copyrightText: "NOASSERTION",
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${inspected.packedManifest.name}-${inspected.packedManifest.version}`,
    documentNamespace: `https://github.com/Melbourneandrew/agentscope/releases/materials/${inspected.sha256.slice(7)}`,
    creationInfo: {
      creators: ["Tool: Agentscope CLI release material producer"],
      created: build.observedAt,
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package",
        name: inspected.packedManifest.name,
        versionInfo: inspected.packedManifest.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: inspected.packedManifest.license ?? "NOASSERTION",
        copyrightText: "NOASSERTION",
        checksums: [
          { algorithm: "SHA256", checksumValue: inspected.sha256.slice(7) },
        ],
      },
      ...components,
    ],
    files,
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package",
      },
      ...[...components, ...files].map((value) => ({
        spdxElementId: "SPDXRef-Package",
        relationshipType: "CONTAINS",
        relatedSpdxElement: value.SPDXID,
      })),
      {
        spdxElementId: "SPDXRef-Package",
        relationshipType: "CONTAINS",
        relatedSpdxElement:
          "DocumentRef-InstallationDirectory:SPDXRef-DOCUMENT",
      },
    ],
    externalDocumentRefs: [
      {
        externalDocumentId: "DocumentRef-InstallationDirectory",
        spdxDocument: JSON.parse(
          directoryRecords["sbom.spdx.json"].toString("utf8"),
        ).documentNamespace,
        checksum: {
          algorithm: "SHA256",
          checksumValue: sha(directoryRecords["sbom.spdx.json"]),
        },
      },
    ],
  };
}

/** Existing role bytes from real build/pack observations; no support mint. */
export function createReleaseMaterialRoles({
  build,
  inspected,
  directoryRecords,
}) {
  fail(
    build.builds.length === 9 && /^[a-f0-9]{40}$/u.test(build.sourceRevision),
  );
  fail(
    build.package.name === inspected.packedManifest.name &&
      build.package.version === inspected.packedManifest.version,
  );
  validatePackedFiles(build, inspected);
  const directoryPrefix = "dist/internal/directory-runtime/records/";
  const materialNames = [
    "sbom.spdx.json",
    "provenance.json",
    "release-materials.json",
  ];
  for (const name of materialNames) {
    const bytes = directoryRecords[name];
    fail(Buffer.isBuffer(bytes));
    fail(
      build.files.find((value) => value.path === `${directoryPrefix}${name}`)
        ?.sha256 === sha(bytes),
    );
    JSON.parse(bytes.toString("utf8"));
  }
  const sbom = createSpdxDocument(build, inspected, directoryRecords);
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `${inspected.packedManifest.name}-${inspected.packedManifest.version}.tgz`,
        digest: { sha256: inspected.sha256.slice(7) },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/Melbourneandrew/agentscope/tree/main/apps/cli/build.mjs",
        externalParameters: { sourceRevision: build.sourceRevision },
        internalParameters: {
          tools: build.tools,
          scripts: build.scripts,
          observedInvocation: build.invocation,
        },
        resolvedDependencies: [
          { uri: "pnpm-lock.yaml", digest: { sha256: build.lockfile.sha256 } },
          ...materialNames.map((name) => ({
            uri: `${directoryPrefix}${name}`,
            digest: { sha256: sha(directoryRecords[name]) },
          })),
        ],
      },
      runDetails: {
        builder: {
          id: `https://github.com/Melbourneandrew/agentscope/blob/${build.sourceRevision}/apps/cli/build.mjs`,
        },
        metadata: { startedOn: build.startedAt, finishedOn: build.observedAt },
        byproducts: [
          {
            name: "observed-esbuild-materials.json",
            content: Buffer.from(JSON.stringify(build)).toString("base64"),
          },
        ],
      },
    },
  };
  // A statement is deliberately not a DSSE/signature bundle. Later npm
  // provenance verification is separate; these observations confer no authority.
  const roles = {
    "sbom.json": json(sbom),
    "attestations.json": json([provenance]),
  };
  fail(Object.values(roles).every((bytes) => bytes.length <= 2_097_152));
  return roles;
}
