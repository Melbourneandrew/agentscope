import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: (_command, args) =>
    args[0] === "status" ? "" : "a".repeat(40),
}));
import {
  createReleaseBuildRecorder,
  createReleaseMaterialRoles,
} from "../release-materials.mjs";

const roots = [];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = (root, path, value) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  writeFileSync(target, bytes);
  return bytes;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function prepareFixtureFiles(root) {
  const workflows = new URL("../../../../.github/workflows/", import.meta.url);
  for (const name of readdirSync(workflows))
    if (/\.ya?ml$/u.test(name))
      put(
        root,
        `.github/workflows/${name}`,
        readFileSync(new URL(name, workflows)),
      );
  put(root, "package.json", { packageManager: "pnpm@9.15.0" });
  put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put(root, "apps/cli/package.json", {
    name: "agentscope-cli",
    version: "0.1.0",
    license: "MIT",
  });
  const input = put(
    root,
    "packages/core/dist/input.js",
    "export const captured = 1;",
  );
  put(root, "packages/core/package.json", {
    name: "@agentscope/core",
    version: "0.1.0",
    license: "MIT",
  });
  const dependency = put(
    root,
    "node_modules/.pnpm/component@2.0.0/node_modules/component/index.js",
    "export const dep = 2;",
  );
  put(
    root,
    "node_modules/.pnpm/component@2.0.0/node_modules/component/package.json",
    { name: "component", version: "2.0.0", license: "Apache-2.0" },
  );
  put(root, "packages/destinations/local-sqlite/package.json", {
    name: "@agentscope/destination-local-sqlite",
    version: "0.1.0",
    license: "MIT",
  });
  put(
    root,
    "packages/destinations/local-sqlite/child.js",
    "export const dormant = 3;",
  );
  for (const path of [
    "build.mjs",
    "scripts/release-materials.mjs",
    "scripts/directory-artifact.mjs",
  ])
    put(root, `apps/cli/${path}`, "// synthetic build source");
  const directoryRecords = {
    "sbom.spdx.json": Buffer.from(
      JSON.stringify({
        documentNamespace: "https://example.invalid/inert-directory-component",
        SPDXID: "SPDXRef-DOCUMENT",
      }),
    ),
    "provenance.json": Buffer.from(
      JSON.stringify({
        disposition: "proposed-unpublished-execution-eligible",
        sourceCommit: "b".repeat(40),
      }),
    ),
    "release-materials.json": Buffer.from(
      JSON.stringify({
        candidateRunId: "123",
        disposition: "proposed-unpublished-execution-eligible",
      }),
    ),
  };
  for (const [name, bytes] of Object.entries(directoryRecords))
    put(
      root,
      `apps/cli/dist/internal/directory-runtime/records/${name}`,
      bytes,
    );
  put(
    root,
    "apps/cli/dist/internal/directory-runtime/native/napi8-linux-x64-glibc/directory.node",
    "inert-native-fixture",
  );
  put(
    root,
    "apps/cli/dist/internal/directory-runtime/notices/node-MIT.txt",
    "synthetic notice",
  );
  put(
    root,
    "apps/cli/dist/internal/local-sqlite-runtime/migrations/0001.sql",
    "-- inert migration",
  );
  return { input, dependency, directoryRecords };
}

function syntheticEngine(packageRoot, { input, dependency }) {
  let call = 0;
  return vi.fn(async (options) => {
    const embedded = options.write === false;
    const output = Buffer.from(`synthetic-program-${call++}`);
    if (!embedded) put(packageRoot, options.outfile, output);
    const names = [
      "../../packages/core/dist/input.js",
      "../../node_modules/.pnpm/component@2.0.0/node_modules/component/index.js",
      "../../packages/destinations/local-sqlite/child.js",
    ];
    const inputs = Object.fromEntries(
      names.map((path, index) => [
        path,
        { bytes: [input.length, dependency.length, 25][index] },
      ]),
    );
    inputs[names[2]].bytes = readFileSync(join(packageRoot, names[2])).length;
    if (options.stdin)
      inputs[options.stdin.sourcefile] = {
        bytes: Buffer.byteLength(options.stdin.contents),
      };
    for (const [name, value] of Object.entries(options.define ?? {}))
      if (value.startsWith("[") || value.startsWith("{"))
        inputs[`<define:${name}>`] = { bytes: Buffer.byteLength(value) };
    return {
      outputFiles: embedded ? [{ contents: output }] : undefined,
      metafile: {
        inputs,
        outputs: {
          [embedded ? "<stdout>" : options.outfile]: {
            bytes: output.length,
            inputs: Object.fromEntries(
              Object.keys(inputs).map((name) => [name, { bytesInOutput: 1 }]),
            ),
          },
        },
      },
    };
  });
}

async function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agentscope-release-materials-")),
  );
  roots.push(root);
  const packageRoot = join(root, "apps/cli");
  const materials = prepareFixtureFiles(root);
  const engine = syntheticEngine(packageRoot, materials);
  const recorder = createReleaseBuildRecorder({
    repositoryRoot: root,
    packageRoot,
    engine,
    version: "0.28.2",
  });
  const first = await recorder.build({ write: false });
  await recorder.build({ write: false });
  for (let index = 0; index < 7; index++)
    await recorder.build({
      outfile: `dist/output-${index}.js`,
      ...(index === 0
        ? {
            stdin: { sourcefile: "virtual-entry.ts", contents: "export {};" },
            define: {
              __AGENTSCOPE_HOOK_HARNESS_TYPES__: JSON.stringify([
                "@agentscope/harness-codex",
                "@agentscope/harness-claude-code",
              ]),
              __COORDINATOR_PROGRAM__: JSON.stringify(
                Buffer.from(first.outputFiles[0].contents).toString(),
              ),
            },
          }
        : {}),
    });
  const build = recorder.finish();
  if (build.invocation.environment === "github-actions") {
    const workflowPath = build.invocation.workflowRef
      .split("/")
      .slice(2)
      .join("/")
      .split("@")[0];
    expect(build.invocation.workflowSha256).toBe(
      sha(readFileSync(join(root, workflowPath))),
    );
    expect(build.invocation.authenticated).toBe(false);
  }
  const packedManifest = {
    name: "agentscope-cli",
    version: "0.1.0",
    license: "MIT",
  };
  const inventory = build.files.map((value) => ({
    ...value,
    path: `package/${value.path}`,
    sha256: `sha256:${value.sha256}`,
  }));
  inventory.push({
    path: "package/package.json",
    bytes: JSON.stringify(packedManifest).length,
    sha256: `sha256:${sha(JSON.stringify(packedManifest))}`,
  });
  const inspected = {
    packedManifest,
    inventory,
    sha256: `sha256:${sha("synthetic-tar")}`,
    integrity: "sha512-synthetic",
    inventoryDigest: `sha256:${sha(JSON.stringify(inventory))}`,
  };
  return {
    root,
    packageRoot,
    build,
    inspected,
    directoryRecords: materials.directoryRecords,
    engine,
    recorder,
  };
}

describe("observed whole CLI release materials (synthetic inputs only)", () => {
  it("accounts all bundles, embedded children, virtual input, dormant Local JS and exact copies", async () => {
    const value = await fixture();
    const roles = createReleaseMaterialRoles(value);
    const sbom = JSON.parse(roles["sbom.json"]);
    const [statement] = JSON.parse(roles["attestations.json"]);
    expect(value.engine).toHaveBeenCalledTimes(9);
    expect(
      value.engine.mock.calls.every(
        ([options]) =>
          options.metafile && options.absWorkingDir === value.packageRoot,
      ),
    ).toBe(true);
    expect(
      value.build.builds.filter((invocation) => invocation.outputs[0].embedded),
    ).toHaveLength(2);
    expect(value.build.builds[2].inputs.some((input) => input.virtual)).toBe(
      true,
    );
    expect(
      value.build.builds[2].defines.find(
        (row) => row.name === "__COORDINATOR_PROGRAM__",
      ).programSha256,
    ).toBe(value.build.builds[0].outputs[0].sha256);
    expect(sbom.packages.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "agentscope-cli",
        "@agentscope/core",
        "component",
        "@agentscope/destination-local-sqlite",
      ]),
    );
    expect(
      sbom.packages.filter((row) => row.name === "component"),
    ).toHaveLength(1);
    expect(sbom.files).toHaveLength(value.inspected.inventory.length);
    expect(sbom.files.map((row) => row.fileName)).toContain(
      "dist/internal/directory-runtime/native/napi8-linux-x64-glibc/directory.node",
    );
    expect(sbom.files.map((row) => row.fileName)).toContain(
      "dist/internal/local-sqlite-runtime/migrations/0001.sql",
    );
    expect(sbom.files.map((row) => row.fileName)).not.toContain(
      "dist/internal/local-sqlite/owned-loader.cjs",
    );
    expect(sbom.externalDocumentRefs[0].checksum.checksumValue).toBe(
      sha(value.directoryRecords["sbom.spdx.json"]),
    );
    expect(statement.subject[0].digest.sha256).toBe(
      value.inspected.sha256.slice(7),
    );
    expect(
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.sha256,
    ).toBe(value.build.lockfile.sha256);
    expect(statement).not.toHaveProperty("signatures");
    const observed = JSON.parse(
      Buffer.from(
        statement.predicate.runDetails.byproducts[0].content,
        "base64",
      ).toString(),
    );
    expect(observed.builds).toHaveLength(9);
    expect(JSON.stringify(observed)).not.toContain(value.root);
    expect(createReleaseMaterialRoles(value)).toEqual(roles);
  });
});

describe("release material refusals", () => {
  it.each([
    "missing-file",
    "different-digest",
    "extra-file",
    "changed-version",
    "missing-build",
    "changed-directory",
  ])("refuses %s before producing role bytes", async (kind) => {
    const value = await fixture();
    if (kind === "missing-file") value.inspected.inventory.shift();
    if (kind === "different-digest")
      value.inspected.inventory[0].sha256 = `sha256:${"f".repeat(64)}`;
    if (kind === "extra-file")
      value.inspected.inventory.push({
        path: "package/extra.js",
        bytes: 1,
        sha256: `sha256:${"f".repeat(64)}`,
      });
    if (kind === "changed-version")
      value.inspected.packedManifest.version = "0.2.0";
    if (kind === "missing-build") value.build.builds.pop();
    if (kind === "changed-directory")
      value.directoryRecords["provenance.json"] = Buffer.from("{}");
    expect(() => createReleaseMaterialRoles(value)).toThrow();
  });
  it("refuses incomplete invocations and unknown embedded program substitutions", async () => {
    const value = await fixture();
    const incomplete = createReleaseBuildRecorder({
      repositoryRoot: value.root,
      packageRoot: value.packageRoot,
      engine: value.engine,
      version: "0.28.2",
    });
    expect(() => incomplete.finish()).toThrow();
    await expect(
      incomplete.build({
        outfile: "dist/substituted.js",
        define: {
          __COORDINATOR_PROGRAM__: JSON.stringify("not-the-observed-program"),
        },
      }),
    ).rejects.toThrow();
  });
});

describe("compiler-injected define input observations", () => {
  it("binds compiler-injected complex defines to the exact options bytes", async () => {
    const value = await fixture();
    const input = value.build.builds[2].inputs.find(
      (row) => row.path === "<define:__AGENTSCOPE_HOOK_HARNESS_TYPES__>",
    );
    const bytes = Buffer.from(
      JSON.stringify([
        "@agentscope/harness-codex",
        "@agentscope/harness-claude-code",
      ]),
    );
    expect(input).toEqual({
      path: "<define:__AGENTSCOPE_HOOK_HARNESS_TYPES__>",
      bytes: bytes.length,
      sha256: sha(bytes),
      virtual: true,
    });
    expect(
      value.build.builds[2].outputs[0].inputs.some(
        (row) => row.path === input.path,
      ),
    ).toBe(true);
  });
  it.each(["unknown-define", "unknown-pseudo", "wrong-byte-count"])(
    "refuses unbound compiler pseudo input %s",
    async (kind) => {
      const value = await fixture();
      const name =
        kind === "unknown-pseudo"
          ? "<unknown>"
          : "<define:__AGENTSCOPE_HOOK_HARNESS_TYPES__>";
      const define = { __AGENTSCOPE_HOOK_HARNESS_TYPES__: '["codex"]' };
      const recorder = createReleaseBuildRecorder({
        repositoryRoot: value.root,
        packageRoot: value.packageRoot,
        version: "0.28.2",
        engine: async () => ({
          outputFiles: [{ contents: Buffer.from("x") }],
          metafile: {
            inputs: {
              [name]: {
                bytes:
                  Buffer.byteLength(define.__AGENTSCOPE_HOOK_HARNESS_TYPES__) +
                  (kind === "wrong-byte-count" ? 1 : 0),
              },
            },
            outputs: {},
          },
        }),
      });
      await expect(
        recorder.build({
          write: false,
          ...(kind === "unknown-define" ? {} : { define }),
        }),
      ).rejects.toThrow();
    },
  );
});

describe("actual transformed build input observations", () => {
  it("records actual plugin supplied bytes separately from held original input", async () => {
    const value = await fixture();
    const path = join(value.root, "packages/core/dist/input.js");
    let callback;
    const original = {
      name: "owned-directory-loader-bin-location",
      setup(api) {
        api.onLoad({}, async () => ({ contents: "transformed-content" }));
      },
    };
    value.recorder.plugin(original).setup({
      onLoad(_options, observed) {
        callback = observed;
      },
    });
    const loaded = await callback({ path });
    expect(loaded.contents).toBe("transformed-content");
    // The real recorder observes callbacks in the same engine; this fixture
    // explicitly forwards that callback through the synthetic engine instead.
    const recorder = createReleaseBuildRecorder({
      repositoryRoot: value.root,
      packageRoot: value.packageRoot,
      version: "0.28.2",
      engine: async (options) => {
        let observedCallback;
        options.plugins[0].setup({
          onLoad(_options, observe) {
            observedCallback = observe;
          },
        });
        await observedCallback({ path });
        const name = options.write === false ? "<stdout>" : options.outfile;
        if (options.write !== false) put(value.packageRoot, name, "x");
        return {
          outputFiles: [{ contents: Buffer.from("x") }],
          metafile: {
            inputs: {
              [relative(value.packageRoot, path)]: {
                bytes: Buffer.byteLength(loaded.contents),
              },
            },
            outputs: {
              [name]: {
                bytes: 1,
                inputs: {
                  [relative(value.packageRoot, path)]: { bytesInOutput: 1 },
                },
              },
            },
          },
        };
      },
    });
    for (let index = 0; index < 9; index++)
      await recorder.build({
        plugins: [recorder.plugin(original)],
        ...(index < 2
          ? { write: false }
          : { outfile: `dist/transformed-${index}.js` }),
      });
    const observation = recorder.finish().builds[0].inputs[0];
    expect(observation.sha256).toBe(sha(readFileSync(path)));
    expect(observation.transformation).toEqual({
      plugin: original.name,
      bytes: 19,
      sha256: sha(loaded.contents),
    });
    expect(observation.transformation.sha256).not.toBe(observation.sha256);
  });
  it("changes provenance when actual observed source bytes change", async () => {
    const value = await fixture();
    const previous = createReleaseMaterialRoles(value);
    value.build.builds[0].inputs[0].sha256 = sha("different-observed-source");
    const next = createReleaseMaterialRoles(value);
    expect(next["attestations.json"]).not.toEqual(
      previous["attestations.json"],
    );
    expect(next["sbom.json"]).toEqual(previous["sbom.json"]);
  });
});
